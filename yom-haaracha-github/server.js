'use strict';
/*
 * שרת יום ההערכה.
 * ארכיטקטורה פשוטה ואמינה: Express + node:sqlite (קובץ יחיד).
 * הטיימר מנוהל בשרת (server-authoritative) — שורד ריענון/יציאה/סגירת דפדפן.
 * כל תשובה נשמרת מיד ל-DB (שמירה אוטומטית).
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const XLSX = require('xlsx');
const { db, DB_PATH, seedDayRounds } = require('./db');
const content = require('./lib/content');
const schedule = require('./lib/schedule');
const score = require('./lib/score');
const aiGrade = require('./lib/aiGrade');
const nameMatch = require('./lib/nameMatch');
const monday = require('./lib/monday');

const app = express();
const PORT = process.env.PORT || 3000;
const EXAMINER_PASSWORD = process.env.EXAMINER_PASSWORD || 'admin';
const SLOT_DURATION_SEC = Number(process.env.SLOT_DURATION_SEC || 1200); // 20:00

// ---------- קונפיג מקומי (מפתח AI + webhook לגוגל שיטס) ----------
function loadLocalConfig() {
  let cfg = {};
  try {
    const p = path.join(__dirname, 'config.local.json');
    if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { /* קובץ פגום — מתעלמים */ }
  return cfg;
}
const LOCAL_CFG = loadLocalConfig();
// כתובת ה-webhook של גוגל שיטס (Apps Script). ריק = כבוי לגמרי, לא נשלח כלום החוצה.
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || LOCAL_CFG.sheetsWebhookUrl || '';

// דחיפת שורה לגוגל שיטס בזמן אמת (fire-and-forget; לעולם לא שובר את המבחן).
function pushToSheet(row) {
  if (!SHEETS_WEBHOOK_URL) return; // לא הוגדר — שקט מוחלט
  try {
    fetch(SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(row),
    }).catch(() => {}); // כישלון רשת לא מפריע לכלום
  } catch (e) { /* אף פעם לא זורק החוצה */ }
}

// דוחף לגוגל שיטס את *התשובות המלאות* של פרק אחד (שורה לכל שאלה):
// טקסט השאלה, התשובה המפוענחת, "לא יודע/ת", ונכון/לא-נכון לרב-ברירה.
// אותה לוגיקת פיענוח כמו בייצוא ל-Excel. שקט מוחלט אם ה-webhook לא הוגדר.
function pushChapterAnswers(examinee, slot) {
  if (!SHEETS_WEBHOOK_URL || !examinee || !slot || !slot.chapter_id) return;
  const ch = content.getChapter(slot.chapter_id);
  const rows = db.prepare('SELECT item_id, type, answer, dont_know FROM answers WHERE code = ? AND chapter_id = ?')
    .all(examinee.code, slot.chapter_id);
  const answers = rows.map((a) => {
    const item = ch && (ch.items || []).find((i) => i.id === a.item_id);
    let question = item ? (item.stem || item.prompt || '') : '';
    let answerText = a.answer || '';
    let correct = '';
    if ((a.type === 'mc_apply' || a.type === 'mc_error_dialogue') && item && item.options) {
      const opt = item.options.find((o) => o.id === a.answer);
      answerText = opt ? (opt.text || opt.tex || a.answer) : a.answer;
      correct = opt ? (opt.correct ? 'נכון' : 'לא נכון') : '';
    }
    if (a.dont_know) answerText = '— לא יודע/ת —';
    return { item_id: a.item_id, question, answer: answerText, dont_know: !!a.dont_know, correct };
  });
  if (!answers.length) return;
  pushToSheet({
    event: 'chapter', at: new Date().toISOString(),
    name: examinee.name, round: slot.round,
    subject: slot.subject || '', level: slot.level || '', chapter_id: slot.chapter_id || '',
    answers,
  });
}

// 8mb — קובץ ייבוא של יום שלם (28 נבחנים, 592 תשובות) שוקל ~0.4mb, עם מרווח נוח.
app.use(express.json({ limit: '8mb' }));

// ---------- כלי עזר ----------
const now = () => Date.now();
const examinerTokens = new Set();

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

// זיהוי אנונימי של הקוד (לא חושף את הקוד עצמו בקובץ הבדיקה)
function codeRef(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex').slice(0, 10);
}

const getExamineeByToken = db.prepare('SELECT * FROM examinees WHERE token = ?');
const getExamineeByCode = db.prepare('SELECT * FROM examinees WHERE code = ?');

// נרמול שם להשוואת ייחודיות: מסיר רווחים בקצוות ומכווץ רווחים פנימיים כפולים.
function normName(s) {
  // תקרה של 80 תווים — שם ארוך מדי היה שובר את טבלת המנהל ואת הייצוא
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').slice(0, 80);
}
// חיפוש נבחן לפי שם (מנורמל) — השם הוא הזהות המחייבת. סריקה קטנה (~50 שורות).
function findByName(name) {
  const key = normName(name);
  if (!key) return null;
  const all = db.prepare('SELECT * FROM examinees WHERE day_id IS ? OR day_id = ?').all(activeDayId(), activeDayId());
  return all.find((e) => normName(e.name) === key) || null;
}
// מזהה פנימי קבוע ונסתר לכל נבחן (עליו יושבות תשובות/משבצות/ריאיונות). לא נחשף לנבחן.
function genCode() {
  let c;
  do { c = 'e' + crypto.randomBytes(6).toString('hex'); } while (getExamineeByCode.get(c));
  return c;
}
// האם ה«קוד האישי» שהוזן תואם לנבחן (או שהנבחן עדיין בלי קוד — אז מאמצים את מה שהוזן).
function pinMatches(ex, typedPin) {
  const stored = String(ex.pin == null ? '' : ex.pin).trim();
  const typed = String(typedPin == null ? '' : typedPin).trim();
  if (!stored) return true; // נפתח מראש לפי שם בלבד — הנבחן קובע קוד עכשיו
  return stored === typed;
}

function authExaminee(req, res, next) {
  const token = (req.headers['x-token'] || '').trim();
  const ex = token && getExamineeByToken.get(token);
  if (!ex) return res.status(401).json({ error: 'לא מחובר. יש להתחבר מחדש עם שם וקוד.' });
  req.examinee = ex;
  next();
}

// ---------- תפקיד שלישי: מראיין ----------
// כניסה בסיסמה משותפת + בחירת שם מהרשימה. המראיין הוא *קורא בלבד* על הלו"ז —
// הוא יכול לבקש החלפה, והמנהל מאשר. כך אין שני גורמים שכותבים לאותו מקום.
const INTERVIEWER_PASSWORD = process.env.INTERVIEWER_PASSWORD || 'interview';
const interviewerTokens = new Map();   // token -> interviewer_id

function authInterviewer(req, res, next) {
  const token = (req.headers['x-token'] || '').trim();
  if (!interviewerTokens.has(token)) return res.status(401).json({ error: 'גישת מראיין נדחתה.' });
  const id = interviewerTokens.get(token);
  const iv = db.prepare('SELECT * FROM interviewers WHERE id = ?').get(id);
  if (!iv) return res.status(401).json({ error: 'המראיין אינו קיים יותר.' });
  // מראיין שייך ליום מסוים; אם המנהל עבר ליום אחר — לדרוש כניסה מחדש
  // (אחרת המראיין רואה לו"ז ריק ולא מבין למה).
  if (iv.day_id !== activeDayId()) {
    interviewerTokens.delete(token);
    return res.status(401).json({ error: 'היום הפעיל התחלף — יש להתחבר מחדש.' });
  }
  req.interviewer = iv;
  next();
}

function authExaminer(req, res, next) {
  const token = (req.headers['x-token'] || '').trim();
  if (!examinerTokens.has(token)) return res.status(401).json({ error: 'גישת בוחן נדחתה.' });
  next();
}

function logEvent(code, type, detail) {
  db.prepare('INSERT INTO events (code, type, detail, at) VALUES (?, ?, ?, ?)')
    .run(code || null, type, detail ? String(detail).slice(0, 500) : null, now());
}

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setConfig(key, value) {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// ---------- יום הערכה (הפרדה בין ימים) ----------
// כל הנתונים התפעוליים שייכים ליום הפעיל. נבחן משויך ליום דרך examinees.day_id,
// ומכיוון שתשובות/משבצות/ריאיונות תלויים ב-code של הנבחן — הם נפרדים מעצמם.
// סינון משבצות ליום הפעיל — פעולות סבב לא יגעו בימים אחרים.
const DAY_SCOPE = ' AND code IN (SELECT code FROM examinees WHERE day_id = ?)';
const MIN_ROUNDS = 3;   // תנאי בסיס: מידע כללי + מקצוע + ריאיון
const MAX_ROUNDS = 5;

function activeDayId() {
  const v = getConfig('active_day_id');
  if (v) return Number(v);
  const row = db.prepare('SELECT id FROM days ORDER BY id DESC LIMIT 1').get();
  if (row) { setConfig('active_day_id', row.id); return row.id; }
  return null;
}
function activeDay() {
  const id = activeDayId();
  return id ? db.prepare('SELECT * FROM days WHERE id = ?').get(id) : null;
}
// מספר הסבבים של היום הפעיל (3..5). מחליף את schedule.NUM_ROUNDS הקבוע.
function totalRounds() {
  const d = activeDay();
  const n = d ? Number(d.total_rounds) : schedule.NUM_ROUNDS;
  return Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, n || schedule.NUM_ROUNDS));
}
// כמה מקצועות הנבחן בוחר: תמיד «מידע כללי» + ריאיון, והשאר מקצועות שבחר.
function chosenSubjectCount() {
  return Math.max(1, totalRounds() - 2);
}
// היום *של הנבחן* — לא בהכרח היום הפעיל (המנהל יכול להחליף יום בזמן שנבחן מחובר).
function dayOfExaminee(ex) {
  if (ex && ex.day_id) {
    const d = db.prepare('SELECT * FROM days WHERE id = ?').get(ex.day_id);
    if (d) return d;
  }
  return activeDay();
}
function isDayClosed(d) { return !!(d && d.status === 'closed'); }
// ⚠ שליפת נבחן לפעולת מנהל — חייבת להיות מוגבלת ליום הפעיל. אחרת המנהל שעבר
// לצפות ביום קודם והמסך טרם התרענן עלול למחוק/לשנות נבחן של יום אחר.
function examineeOfActiveDay(code) {
  // המרה בטוחה: code חסר/לא-סקלרי גרם ל-500 מ-node:sqlite במקום שגיאה מסבירה
  const c = (code == null) ? '' : String(code);
  if (!c) return { err: 400, msg: 'חסר קוד נבחן.' };
  const ex = getExamineeByCode.get(c);
  if (!ex) return { err: 404, msg: 'נבחן לא נמצא.' };
  if (ex.day_id !== activeDayId()) return { err: 409, msg: 'הנבחן «' + ex.name + '» שייך ליום אחר. החליפו יום ונסו שוב.' };
  return { ex: ex };
}
// כל מצב הנבחן נגזר מהיום *שלו* — אחרת החלפת/יצירת יום באמצע מבחן הייתה
// מרוקנת את המסך של כל הנבחנים בזמן שהטיימרים ממשיכים לרוץ.
function runningRoundOfDay(dayId) {
  const row = db.prepare("SELECT MAX(round) AS r FROM day_rounds WHERE day_id = ? AND state = 'running'").get(dayId);
  return row && row.r ? row.r : null;
}

// «המבחן הסתיים» ו«הודעת הסיום» הם מצב של *היום* — לא של המערכת כולה.
function examEnded() {
  const d = activeDay();
  return !!(d && d.exam_ended);
}
function setExamEnded(v) {
  db.prepare('UPDATE days SET exam_ended = ? WHERE id = ?').run(v ? 1 : 0, activeDayId());
}
const DEFAULT_FINISH_MSG = 'המבחן הסתיים — תודה רבה! נא לעבור למשבצת הבאה לפי ההנחיות של הצוות.';
function finishMessage() {
  const d = activeDay();
  const m = d && d.finish_message != null ? String(d.finish_message).trim() : '';
  return m || DEFAULT_FINISH_MSG;
}

function dayPhase() {
  const d = activeDay();
  return d ? (d.phase || 'registration') : 'registration';
}

// ---------- מצב סבבים (מודל חי, פר-יום) ----------
function roundState(r) {
  const row = db.prepare('SELECT state FROM day_rounds WHERE day_id = ? AND round = ?').get(activeDayId(), r);
  return row ? row.state : 'planned';
}
// הסבב שרץ כרגע (0 אם אין)
function currentRunningRound() {
  const row = db.prepare("SELECT MAX(round) AS r FROM day_rounds WHERE day_id = ? AND state = 'running'").get(activeDayId());
  return row && row.r ? row.r : 0;
}
// הסבב הגבוה ביותר שכבר התחיל (running/ended)
function latestActiveRound() {
  const row = db.prepare("SELECT MAX(round) AS r FROM day_rounds WHERE day_id = ? AND state != 'planned'").get(activeDayId());
  return row && row.r ? row.r : 0;
}
// התאמת טבלת הסבבים למספר המבוקש. מוסיף חסרים; מוחק עודפים רק אם הם 'planned'
// ואין להם משבצות — אחרת מחזיר שגיאה מסבירה (הגנה על תיקון-טעות בלייב).
function reconcileRounds(dayId, n) {
  const rows = db.prepare('SELECT round, state FROM day_rounds WHERE day_id = ? ORDER BY round').all(dayId);
  const have = rows.map((r) => r.round);
  const maxHave = have.length ? Math.max(...have) : 0;
  for (let r = 1; r <= n; r++) {
    if (!have.includes(r)) {
      db.prepare('INSERT OR IGNORE INTO day_rounds (day_id, round, code, released, state) VALUES (?, ?, ?, 0, ?)')
        .run(dayId, r, 'round' + r, 'planned');
    }
  }
  for (let r = n + 1; r <= maxHave; r++) {
    const row = rows.find((x) => x.round === r);
    if (!row) continue;
    if (row.state !== 'planned') {
      throw Object.assign(new Error('סבב ' + r + ' כבר רץ או הסתיים — אפסו אותו לפני הקטנת מספר הסבבים.'), { status: 400 });
    }
    const used = db.prepare(
      'SELECT COUNT(*) AS c FROM slots WHERE round = ? AND code IN (SELECT code FROM examinees WHERE day_id = ?)'
    ).get(r, dayId).c;
    if (used > 0) {
      throw Object.assign(new Error('בסבב ' + r + ' יש נבחנים משובצים — אפסו את הסבב לפני ההקטנה.'), { status: 400 });
    }
    db.prepare('DELETE FROM day_rounds WHERE day_id = ? AND round = ?').run(dayId, r);
    db.prepare('DELETE FROM interview_marks WHERE round = ? AND code IN (SELECT code FROM examinees WHERE day_id = ?)').run(r, dayId);
  }
}

// ---------- התקדמות פר-נבחן (נגזרת מ-slots + interview_marks) ----------
function servedChapterIds(code, exceptRound) {
  const rows = exceptRound
    ? db.prepare("SELECT DISTINCT chapter_id FROM slots WHERE code = ? AND kind = 'chapter' AND round != ?").all(code, exceptRound)
    : db.prepare("SELECT DISTINCT chapter_id FROM slots WHERE code = ? AND kind = 'chapter'").all(code);
  return new Set(rows.map((r) => r.chapter_id));
}
// מעקב "נעשה" לפי מקצוע (ולא לפי chapter_id) — כך "החלף שאלה" יכול להחליף נושא באותו מקצוע
// בלי שהמקצוע המקורי יחזור בסבב מאוחר.
function servedSubjects(code, exceptRound) {
  const rows = exceptRound
    ? db.prepare("SELECT DISTINCT subject FROM slots WHERE code = ? AND kind = 'chapter' AND round != ?").all(code, exceptRound)
    : db.prepare("SELECT DISTINCT subject FROM slots WHERE code = ? AND kind = 'chapter'").all(code);
  return new Set(rows.map((r) => r.subject));
}
function doneSubjects(code) {
  return new Set(db.prepare("SELECT DISTINCT subject FROM slots WHERE code = ? AND kind = 'chapter' AND status = 'done'").all(code).map((r) => r.subject));
}
function doneChapterIds(code) {
  return new Set(db.prepare("SELECT DISTINCT chapter_id FROM slots WHERE code = ? AND kind = 'chapter' AND status = 'done'").all(code).map((r) => r.chapter_id));
}
function hasInterviewed(code) {
  const r = db.prepare('SELECT interviewed FROM examinees WHERE code = ?').get(code);
  return !!(r && r.interviewed);
}
function isMarkedInterview(round, code) {
  return !!db.prepare('SELECT 1 FROM interview_marks WHERE round = ? AND code = ?').get(round, code);
}
// מראיין אחד מראיין נבחן אחד בסבב. מחזיר את שם הנבחן התפוס, או null אם פנוי.
function interviewerBusy(interviewerId, round, exceptCode) {
  if (!interviewerId || !round) return null;
  const row = db.prepare(`SELECT e.name AS name FROM interview_marks m JOIN examinees e ON e.code = m.code
                          WHERE m.interviewer_id = ? AND m.round = ? AND m.code != ? AND e.day_id = ?
                          LIMIT 1`).get(interviewerId, round, exceptCode || '', activeDayId());
  return row ? row.name : null;
}

// לאן הנבחן הולך לריאיון: שם המראיין והחדר (מראיין = חדר קבוע). ריק אם לא שובץ.
function interviewWhere(code, round) {
  if (!round) return { interviewer: null, room: null };
  const row = db.prepare(`SELECT i.name AS name, i.room AS room
                          FROM interview_marks m JOIN interviewers i ON i.id = m.interviewer_id
                          WHERE m.code = ? AND m.round = ?`).get(code, round);
  return { interviewer: row ? row.name : null, room: row ? (row.room || null) : null };
}
function chapterListForEx(ex) {
  return schedule.chapterListFor(JSON.parse(ex.subjects || '[]'), ex.math_level, chosenSubjectCount());
}

// מה נבחן עושה בסבב נתון (מחושב בעת התחלת הסבב). מחזיר תיאור משבצת או null (idle).
// מעקב לפי *כמות פרקים למקצוע* (ולא רק "נעשה/לא"): כך אפשר שמקצוע יחזור כמה פעמים
// (כשנבחרו פחות מ-3 והראשי ממלא), והספירה-לפי-מקצוע עמידה ל"החלף שאלה" (החלפת וריאנט
// אינה מוסיפה מקצוע). לכל חזרה נבחר וריאנט שטרם נעשה.
function resolveActivity(ex, round) {
  if (isMarkedInterview(round, ex.code) && !hasInterviewed(ex.code)) {
    return { kind: 'interview', subject: null, level: null, chapter_id: null };
  }
  const list = chapterListForEx(ex);
  const servedRows = db.prepare("SELECT subject FROM slots WHERE code = ? AND kind = 'chapter' AND round != ?").all(ex.code, round);
  const servedCount = {};
  for (const r of servedRows) servedCount[r.subject] = (servedCount[r.subject] || 0) + 1;
  const servedIds = servedChapterIds(ex.code, round);
  const seen = {};
  for (const c of list) {
    const k = seen[c.subject] || 0;
    seen[c.subject] = k + 1;
    if (k < (servedCount[c.subject] || 0)) continue; // מופע זה של המקצוע כבר שובץ בסבב אחר
    // מופע שטרם שובץ — נעדיף את הפרק המתוכנן; אם כבר נעשה (למשל אחרי החלפה) נבחר וריאנט אחר שטרם נעשה.
    let chapterId = c.chapter_id;
    if (servedIds.has(chapterId)) {
      const alt = (content.bySubject.get(c.subject) || []).find((ch) =>
        (c.subject !== 'מתמטיקה' || !c.level || String(ch.level) === String(c.level)) && !servedIds.has(ch.chapter_id));
      if (alt) chapterId = alt.chapter_id;
    }
    return { kind: 'chapter', subject: c.subject, level: c.level, chapter_id: chapterId };
  }
  return null; // אין פרק נותר — idle (צריך ריאיון או שסיים)
}

// חישוב מצב טיימר עבור משבצת
function computeTimer(slot) {
  if (!slot || slot.kind !== 'chapter') {
    return { state: 'none', remaining_sec: 0, duration_sec: 0 };
  }
  if (!slot.started_at || slot.status === 'pending') {
    return { state: 'not_started', remaining_sec: slot.duration_sec, duration_sec: slot.duration_sec };
  }
  const t = now();
  let pausedSec = slot.paused_accum_sec;
  if (slot.paused && slot.paused_at) pausedSec += Math.floor((t - slot.paused_at) / 1000);
  const elapsed = Math.floor((t - slot.started_at) / 1000) - pausedSec;
  const remaining = Math.max(0, slot.duration_sec - elapsed);
  return {
    state: slot.paused ? 'paused' : (remaining <= 0 ? 'expired' : 'running'),
    remaining_sec: remaining,
    duration_sec: slot.duration_sec,
  };
}

// חישוב שעון הסבב — מקור אמת אחד לשלושת המסכים (מנהל · מראיין · נבחן שהגיש).
// ⚠ נמדד מרגע לחיצת «התחל סבב» (`day_rounds.started_at`), ולא מהרגע שהנבחן
// הראשון פתח את הפרק — כך המספר זהה אצל כולם ואינו תלוי במי נכנס ראשון.
// אותה מתמטיקה של `computeTimer`, כולל חשבון ההשהיה.
function computeRoundTimer(dayId, round) {
  const none = { round: round || 0, state: 'none', remaining_sec: 0, overtime_sec: 0, duration_sec: 0, started_at: null, ends_at: null };
  if (!dayId || !round) return none;
  const r = db.prepare('SELECT * FROM day_rounds WHERE day_id = ? AND round = ?').get(dayId, round);
  if (!r || r.state !== 'running' || !r.started_at) return none;
  const durSec = Number(r.duration_sec) || SLOT_DURATION_SEC;
  const t = now();
  let pausedSec = Number(r.paused_accum_sec) || 0;
  if (r.paused && r.paused_at) pausedSec += Math.floor((t - r.paused_at) / 1000);
  const elapsed = Math.floor((t - r.started_at) / 1000) - pausedSec;
  const remaining = Math.max(0, durSec - elapsed);
  return {
    round,
    state: r.paused ? 'paused' : (remaining <= 0 ? 'expired' : 'running'),
    remaining_sec: remaining,
    // בחריגה סופרים *קדימה*, בלי מספרים שליליים על המסך.
    overtime_sec: Math.max(0, elapsed - durSec),
    duration_sec: durSec,
    started_at: r.started_at,
    // «מסתיים» כולל את זמן ההשהיה שנצבר, אחרת השעה שמוצגת נסוגה אחורה.
    ends_at: r.started_at + (durSec + pausedSec) * 1000,
  };
}

function getSlot(code, round) {
  return db.prepare('SELECT * FROM slots WHERE code = ? AND round = ?').get(code, round);
}

// מפעיל את הטיימר של משבצת פרק ברגע שהנבחן נכנס אליה בפעם הראשונה.
function ensureSlotStarted(code, round) {
  const slot = getSlot(code, round);
  if (!slot || slot.kind !== 'chapter') return slot;
  if (slot.status === 'pending' && !slot.started_at) {
    db.prepare('UPDATE slots SET started_at = ?, status = ? WHERE code = ? AND round = ?')
      .run(now(), 'active', code, round);
    return getSlot(code, round);
  }
  return slot;
}

// ---------- בניית מצב מלא לנבחן (לשחזור מדויק) ----------
function buildExamineeState(ex) {
  const exDayEarly = dayOfExaminee(ex);
  const exDayId = exDayEarly ? exDayEarly.id : activeDayId();
  const running = runningRoundOfDay(exDayId);
  const total = exDayEarly ? exDayEarly.total_rounds : totalRounds();
  const state = {
    examinee: {
      name: ex.name,
      code: ex.code,
      subjects: JSON.parse(ex.subjects || '[]'),
      math_level: ex.math_level,
    },
    rounds: { current: running, total: total },
    server_now: now(),
    // ⚠ מחוץ לפיצול ה-phase בכוונה: גם מסך «הפרק הוגש» ומסך ההמתנה צריכים
    // את שעון הסבב, לא רק phase='chapter'.
    round_timer: computeRoundTimer(exDayId, running),
  };

  // המבחן הסתיים על-ידי הבוחן, או שהיום נסגר (ארכיון) — לפי היום *של הנבחן*
  const exDay = exDayEarly;
  if ((exDay && exDay.exam_ended) || isDayClosed(exDay)) {
    state.phase = 'ended';
    const m = exDay && exDay.finish_message != null ? String(exDay.finish_message).trim() : '';
    state.message = m || DEFAULT_FINISH_MSG;
    return state;
  }

  // M9: נבחן שסומן «עזב» — מסך סיום, לא המתנה אינסופית לסבב הבא
  if (ex.status === 'left') {
    state.phase = 'ended';
    const lm = exDay && exDay.finish_message != null ? String(exDay.finish_message).trim() : '';
    state.message = lm || DEFAULT_FINISH_MSG;
    return state;
  }

  // שלב ההרשמה של הבוקר: נרשמנו — וממתינים. בלי חשיפה להוראות/הצהרה/מקצועות.
  if ((exDay ? exDay.phase : dayPhase()) === 'registration') {
    state.phase = 'registered_waiting';
    state.message = 'ההרשמה נרשמה בהצלחה. נתראה בתחילת המבחן — אפשר לסגור את החלון ולחזור לכאן בהמשך.';
    return state;
  }

  // נבחן שעדיין לא בחר מקצועות — צריך להשלים הרשמה
  const subjectsArr = JSON.parse(ex.subjects || '[]');
  if (!subjectsArr.length) {
    state.phase = 'needs_setup';
    state.message = 'ברוך הבא! יש להשלים שאלון הצהרה ובחירת נושאים כדי להתחיל.';
    return state;
  }

  // יצא לריאיון (טיימר הפרק מושהה) — מסך ריאיון עד לחזרה
  if (ex.in_interview) {
    const r = running;
    state.phase = 'interview';
    state.slot = Object.assign({ round: r, kind: 'interview' }, interviewWhere(ex.code, r));
    state.message = 'יצאת לריאיון — הטיימר מושהה. כשתחזור/י תמשיך/י בדיוק מהמקום.';
    return state;
  }

  // סיים הכול (התראיין + כל הפרקים) — מסך סיום
  const chapterList = chapterListForEx(ex);
  const doneChapterCount = db.prepare("SELECT COUNT(*) AS c FROM slots WHERE code = ? AND kind = 'chapter' AND status = 'done'").get(ex.code).c;
  const allChaptersDone = chapterList.length > 0 && doneChapterCount >= chapterList.length;
  if (running === 0 && hasInterviewed(ex.code) && allChaptersDone) {
    state.phase = 'finished';
    state.message = 'סיימת את כל המשבצות — תודה רבה!';
    return state;
  }

  if (running === 0) {
    state.phase = 'waiting';
    state.message = 'ממתינים לתחילת הסבב הבא על-ידי הבוחן.';
    return state;
  }

  let slot = getSlot(ex.code, running);
  if (!slot) {
    // אין משבצת לנבחן בסבב הרץ (הצטרף מאוחר / סיים / ממתין לתורו)
    if (hasInterviewed(ex.code) && allChaptersDone) {
      state.phase = 'finished';
      state.message = 'סיימת את כל המשבצות — תודה רבה!';
    } else {
      state.phase = 'waiting';
      state.message = 'ממתינים לתחילת הסבב הבא.';
    }
    return state;
  }

  if (slot.kind === 'interview') {
    const where = interviewWhere(ex.code, slot.round);
    state.phase = 'interview';
    state.slot = Object.assign({ round: slot.round, kind: 'interview' }, where);
    state.message = where.room || where.interviewer
      ? 'זהו סבב הריאיון שלך — הגע/י לחדר המצוין למטה.'
      : 'זהו סבב הריאיון שלך — צא/צאי לריאיון. הטיימר מושהה עד לחזרה.';
    return state;
  }

  // הנבחן כבר הגיש את הפרק (או שהבוחן סיים אותו) — ממתין לסבב הבא
  if (slot.status === 'done') {
    state.phase = 'submitted';
    state.slot = { round: slot.round, kind: 'chapter', subject: slot.subject };
    state.message = 'הפרק הוגש. ממתינים לתחילת הסבב הבא על-ידי הבוחן.';
    return state;
  }

  // משבצת פרק — מפעילים טיימר בכניסה ראשונה
  slot = ensureSlotStarted(ex.code, running);
  const chapter = content.getChapter(slot.chapter_id);
  state.phase = 'chapter';
  state.slot = {
    round: slot.round,
    kind: 'chapter',
    subject: slot.subject,
    level: slot.level,
    chapter_id: slot.chapter_id,
    not_comfortable: !!slot.not_comfortable,
  };
  state.chapter = content.sanitizeForExaminee(chapter);
  state.timer = computeTimer(slot);
  // תשובות שכבר נשמרו (לשחזור)
  state.answers = db.prepare(
    'SELECT item_id, type, answer, time_spent_sec, dont_know FROM answers WHERE code = ? AND chapter_id = ?'
  ).all(ex.code, slot.chapter_id);
  return state;
}

// ============================================================
//  נקודות קצה — נבחן
// ============================================================

// רשימת המקצועות הזמינים לבחירה במבחן. «מידע כללי» מוסתר — הוא פרק חובה
// שמשובץ אוטומטית לכולם ואינו נבחר על ידי הנבחן.
app.get('/api/subjects', (req, res) => {
  res.json({ subjects: content.listSubjects().filter((s) => s !== schedule.GENERAL_SUBJECT) });
});

// מידע ציבורי על היום: כותרת לדף הכניסה + השלב (registration/open) — כדי שדף
// הכניסה ידע להציג «הרשמה לבחינה» ולא לחשוף את ההמשך.
app.get('/api/day-info', (req, res) => {
  const d = activeDay();
  res.json({
    title: (d && d.title) || 'יום הערכה תשפ״ז',
    phase: dayPhase(),
    subject_count: chosenSubjectCount(),
    total_rounds: totalRounds(),
  });
});

// רשימת השמות שהמנהל הזין ליום — לבחירה בהרשמת הבוקר (מונע כפילויות שמות).
// מחזיר שמות בלבד (בלי קודים), ורק של מי שעדיין לא נרשם בפועל.
app.get('/api/day-names', (req, res) => {
  // רק מי שעדיין לא נרשם בפועל (בלי token) — כדי שלא יהיה אפשר "לחטוף" שם
  // של מי שכבר נכנס, במיוחד כשהרשימה הוזנה בלי קודים אישיים.
  const rows = db.prepare("SELECT name FROM examinees WHERE day_id = ? AND (token IS NULL OR token = '') ORDER BY name").all(activeDayId());
  res.json({ names: rows.map((r) => r.name) });
});

// הרשמת בוקר: שם + קוד אישי בלבד. לא נוגע בהצהרה/מקצועות — אלה יבואו
// כשהמנהל יפתח את היום. מסמן דגל אם השם לא היה ברשימה שהמנהל הזין.
app.post('/api/register-morning', (req, res) => {
  const { name, code } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'נדרשים שם וקוד אישי.' });
  const cleanName = normName(name);
  const cleanCode = String(code).trim();
  if (!cleanName) return res.status(400).json({ error: 'נדרש שם.' });

  const existing = findByName(cleanName);
  // יום סגור (ארכיון) — אין יותר הרשמה/כניסה
  const targetDay = existing ? dayOfExaminee(existing) : activeDay();
  if (isDayClosed(targetDay)) {
    return res.status(403).json({ error: 'המבחן הסתיים והיום נסגר — לא ניתן להירשם. אם יש בעיה, פנו לצוות.' });
  }
  if (existing) {
    if (!pinMatches(existing, cleanCode)) {
      return res.status(409).json({ error: 'השם הזה כבר רשום עם קוד אחר. אם זה את/ה — הזן/י את הקוד שבחרת. אחרת פנה/י למנהל.' });
    }
    const token = newToken();
    if (!String(existing.pin || '').trim()) db.prepare('UPDATE examinees SET pin = ? WHERE code = ?').run(cleanCode, existing.code);
    db.prepare("UPDATE examinees SET token = ?, status = CASE WHEN status = 'left' THEN 'left' ELSE status END WHERE code = ?").run(token, existing.code);
    logEvent(existing.code, 'register_morning', 'existing');
    return res.json({ token, restored: true, state: buildExamineeState(getExamineeByCode.get(existing.code)) });
  }

  // שם שאינו ברשימה — נרשם בכל זאת (כדי לא לחסום נבחן בבוקר), אבל מסומן לבדיקה.
  const token = newToken();
  const internalCode = genCode();
  db.prepare(`INSERT INTO examinees (code, name, pin, token, declaration, subjects, math_level, interview_round, created_at, status, day_id, self_registered)
              VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'registered', ?, 1)`).run(
    internalCode, cleanName, cleanCode, token, JSON.stringify(null), JSON.stringify([]), now(), activeDayId());
  logEvent(internalCode, 'register_morning', 'new (self)');
  res.json({ token, restored: false, self_registered: true, state: buildExamineeState(getExamineeByCode.get(internalCode)) });
});

// רישום נבחן חדש (או שחזור אם הקוד כבר קיים עם אותו שם)
app.post('/api/register', (req, res) => {
  const { name, code, declaration, subjects, math_level } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'נדרשים שם וקוד אישי.' });
  const cleanName = String(name).trim();
  const cleanCode = String(code).trim();

  // הזהות היא השם. הקוד האישי חופשי (לא ייחודי) ומשמש לחזרה בלבד.
  const existing = findByName(cleanName);
  if (existing) {
    if (!pinMatches(existing, cleanCode)) {
      return res.status(409).json({ error: 'השם הזה כבר רשום עם קוד אחר. אם זה את/ה — הזן/י את הקוד שבחרת. אחרת בחר/י שם אחר או פנה/י למנהל.' });
    }
    // חזרה של נבחן קיים — אסימון חדש ומצב קיים (מאמצים קוד אם נפתח לפי שם בלבד).
    const token = newToken();
    if (!String(existing.pin || '').trim()) db.prepare('UPDATE examinees SET pin = ? WHERE code = ?').run(cleanCode, existing.code);
    db.prepare('UPDATE examinees SET token = ? WHERE code = ?').run(token, existing.code);
    logEvent(existing.code, 'login', 'register-existing');
    return res.json({ token, restored: true, state: buildExamineeState(getExamineeByCode.get(existing.code)) });
  }

  const validSubjects = content.listSubjects();
  const rawPicks = Array.isArray(subjects) ? subjects.filter((s) => s && s !== schedule.GENERAL_SUBJECT) : [];
  // מקצוע שאינו בבנק היה נופל בשקט וגורם לכפילות פרק — עדיף לדחות במפורש
  if (rawPicks.some((s) => validSubjects.indexOf(s) < 0)) {
    return res.status(400).json({ error: 'אחד המקצועות שנבחרו אינו קיים במערכת. רעננו את הדף ובחרו מהרשימה.' });
  }
  if (math_level != null && String(math_level) !== '' && ['5', '4', '3'].indexOf(String(math_level)) < 0) {
    return res.status(400).json({ error: 'רמת מתמטיקה חייבת להיות 5, 4 או 3.' });
  }
  const chosenSubjects = rawPicks.slice(0, chosenSubjectCount());
  if (chosenSubjects.length === 0) return res.status(400).json({ error: 'יש לבחור לפחות מקצוע אחד.' });
  const mathLevel = chosenSubjects.includes('מתמטיקה') ? (math_level || '5') : null;
  if (schedule.chosenChapterCount(chosenSubjects, mathLevel, chosenSubjectCount()) < chosenSubjectCount()) {
    return res.status(400).json({ error: 'המקצועות שנבחרו אינם מספיקים ל-' + chosenSubjectCount() + ' פרקים. יש להוסיף מקצוע נוסף (למשל, אי אפשר להיבחן רק על «יזמות גירלס פלוס»).' });
  }

  const token = newToken();
  const internalCode = genCode();
  db.prepare(`INSERT INTO examinees (code, name, pin, token, declaration, subjects, math_level, interview_round, created_at, status, day_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'active', ?)`).run(
    internalCode, cleanName, cleanCode, token,
    JSON.stringify(declaration || null),
    JSON.stringify(chosenSubjects),
    mathLevel, now(), activeDayId()
  );
  // אין בניית slots מראש — הן נבנות חי כשהמנהל מתחיל סבב.
  logEvent(internalCode, 'register', cleanName);
  return res.json({ token, restored: false, state: buildExamineeState(getExamineeByCode.get(internalCode)) });
});

// השלמת הרשמה לנבחן שנפתח לו משתמש מראש (בחירת מקצועות + הצהרה)
app.post('/api/complete-setup', authExaminee, (req, res) => {
  const { subjects, math_level, declaration } = req.body || {};
  const validSubjects = content.listSubjects();
  const rawPicks = Array.isArray(subjects) ? subjects.filter((s) => s && s !== schedule.GENERAL_SUBJECT) : [];
  // מקצוע שאינו בבנק היה נופל בשקט וגורם לכפילות פרק — עדיף לדחות במפורש
  if (rawPicks.some((s) => validSubjects.indexOf(s) < 0)) {
    return res.status(400).json({ error: 'אחד המקצועות שנבחרו אינו קיים במערכת. רעננו את הדף ובחרו מהרשימה.' });
  }
  if (math_level != null && String(math_level) !== '' && ['5', '4', '3'].indexOf(String(math_level)) < 0) {
    return res.status(400).json({ error: 'רמת מתמטיקה חייבת להיות 5, 4 או 3.' });
  }
  const chosenSubjects = rawPicks.slice(0, chosenSubjectCount());
  if (chosenSubjects.length === 0) return res.status(400).json({ error: 'יש לבחור לפחות מקצוע אחד.' });
  const ex = req.examinee;
  const mathLevel = chosenSubjects.includes('מתמטיקה') ? (math_level || '5') : null;
  if (schedule.chosenChapterCount(chosenSubjects, mathLevel, chosenSubjectCount()) < chosenSubjectCount()) {
    return res.status(400).json({ error: 'המקצועות שנבחרו אינם מספיקים ל-' + chosenSubjectCount() + ' פרקים. יש להוסיף מקצוע נוסף (למשל, אי אפשר להיבחן רק על «יזמות גירלס פלוס»).' });
  }
  db.prepare('UPDATE examinees SET subjects = ?, math_level = ?, declaration = ?, status = ? WHERE code = ?')
    .run(JSON.stringify(chosenSubjects), mathLevel, JSON.stringify(declaration || null), 'active', ex.code);
  logEvent(ex.code, 'complete_setup', ex.name);

  // ⚠ תיקון עצמי: אם הסבב *כבר רץ* כשהנבחן סיים לבחור מקצועות — לשבץ אותו מיד.
  // אחרת הוא היה נשאר בלי פרק עד הסבב הבא (הסבבים משבצים רק ב-start-round).
  const runningNow = currentRunningRound();
  if (runningNow && !getSlot(ex.code, runningNow)) {
    const fresh = getExamineeByCode.get(ex.code);
    try {
      if (isMarkedInterview(runningNow, ex.code) && !hasInterviewed(ex.code)) {
        db.prepare('INSERT INTO slots (code, round, kind, subject, level, chapter_id, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(code, round) DO NOTHING')
          .run(ex.code, runningNow, 'interview', null, null, null, SLOT_DURATION_SEC);
        logEvent(ex.code, 'late_setup_slot', 'round ' + runningNow + ' interview');
      } else {
        const act = resolveActivity(fresh, runningNow);
        if (act) {
          db.prepare('INSERT INTO slots (code, round, kind, subject, level, chapter_id, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(code, round) DO NOTHING')
            .run(ex.code, runningNow, act.kind, act.subject, act.level, act.chapter_id, SLOT_DURATION_SEC);
          logEvent(ex.code, 'late_setup_slot', 'round ' + runningNow + ' ' + act.kind);
        }
      }
    } catch (e) { /* לא לשבור את ההרשמה בגלל שיבוץ */ }
  }
  res.json({ ok: true, state: buildExamineeState(getExamineeByCode.get(ex.code)) });
});

// התחברות/שחזור עם שם + קוד
app.post('/api/login', (req, res) => {
  const { name, code } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'נדרשים שם וקוד.' });
  const ex = findByName(name);
  if (!ex) {
    // השם עדיין לא רשום → נבחן חדש (הלקוח ימשיך לשאלון ההצהרה).
    return res.status(404).json({ error: 'לא נמצא נבחן עם השם הזה.' });
  }
  if (!pinMatches(ex, code)) {
    return res.status(409).json({ error: 'השם הזה כבר רשום עם קוד אחר. אם זה את/ה — הזן/י את הקוד שבחרת. אחרת בחר/י שם אחר או פנה/י למנהל.' });
  }
  const token = newToken();
  if (!String(ex.pin || '').trim()) db.prepare('UPDATE examinees SET pin = ? WHERE code = ?').run(String(code).trim(), ex.code);
  db.prepare('UPDATE examinees SET token = ? WHERE code = ?').run(token, ex.code);
  logEvent(ex.code, 'login', 'restore');
  res.json({ token, state: buildExamineeState(getExamineeByCode.get(ex.code)) });
});

// מצב נוכחי (הלקוח מבצע polling כדי לזהות שחרור סבב ולסנכרן טיימר)
app.get('/api/state', authExaminee, (req, res) => {
  res.json(buildExamineeState(req.examinee));
});

// שמירה אוטומטית של תשובה (idempotent — נקרא תדיר)
app.post('/api/save-answer', authExaminee, (req, res) => {
  // המרה בטוחה: ערכים לא-סקלריים גרמו ל-500 מ-node:sqlite
  if (req.body) {
    if (req.body.round != null) req.body.round = Number(req.body.round) || 0;
    ['chapter_id', 'item_id', 'type'].forEach((k) => {
      if (req.body[k] != null && typeof req.body[k] !== 'string') req.body[k] = String(req.body[k]);
    });
    if (req.body.answer != null && typeof req.body.answer !== 'string') req.body.answer = String(req.body.answer);
  }
  const { round, chapter_id, item_id, type, answer, time_spent_sec, dont_know } = req.body || {};
  if (!chapter_id || !item_id) return res.status(400).json({ error: 'חסר מזהה פרק או פריט.' });
  const t = now();
  const dk = dont_know ? 1 : 0;
  const existing = db.prepare('SELECT started_at FROM answers WHERE code = ? AND chapter_id = ? AND item_id = ?')
    .get(req.examinee.code, chapter_id, item_id);
  db.prepare(`INSERT INTO answers (code, round, chapter_id, item_id, type, answer, started_at, updated_at, time_spent_sec, dont_know)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(code, chapter_id, item_id) DO UPDATE SET
                answer = excluded.answer,
                type = excluded.type,
                updated_at = excluded.updated_at,
                time_spent_sec = excluded.time_spent_sec,
                dont_know = excluded.dont_know`).run(
    req.examinee.code, round || 0, chapter_id, item_id, type || null,
    typeof answer === 'string' ? answer : JSON.stringify(answer ?? ''),
    existing ? existing.started_at : t, t, Number(time_spent_sec) || 0, dk
  );
  res.json({ ok: true, saved_at: t });
});

// "החלף שאלה" — וריאנט אחר של אותו פריט (אם קיים בבנק)
// בוחר פרק חלופי מאותו מקצוע (ואותה רמה במתמטיקה) שהנבחן טרם עשה בסבב אחר — ל"החלף שאלה".
function pickSwapChapter(code, slot, round) {
  const pool = (content.bySubject.get(slot.subject) || []).filter((c) => {
    if (slot.subject === 'מתמטיקה' && slot.level) return String(c.level) === String(slot.level);
    return true;
  });
  const servedElsewhere = servedChapterIds(code, round); // פרקים שכבר נעשו בסבבים אחרים
  return pool.find((c) => c.chapter_id !== slot.chapter_id && !servedElsewhere.has(c.chapter_id)) || null;
}

app.post('/api/swap-question', authExaminee, (req, res) => {
  const { round } = req.body || {};
  const r = Number(round) || currentRunningRound();
  const slot = getSlot(req.examinee.code, r);
  if (!slot || slot.kind !== 'chapter') return res.status(400).json({ error: 'אין פרק פעיל בסבב זה.' });
  const next = pickSwapChapter(req.examinee.code, slot, r);
  if (!next) {
    return res.json({ swapped: false, message: 'אין נושא חלופי זמין במקצוע זה כרגע.' });
  }
  // מחליפים לנושא אחר מהפול; הטיימר ממשיך לרוץ (החלפה לא מקנה זמן נוסף).
  db.prepare('UPDATE slots SET chapter_id = ?, level = ?, variant_index = 0 WHERE code = ? AND round = ?')
    .run(next.chapter_id, next.level || slot.level, req.examinee.code, r);
  logEvent(req.examinee.code, 'swap', `round ${r} → ${next.chapter_id}`);
  res.json({ swapped: true, state: buildExamineeState(getExamineeByCode.get(req.examinee.code)) });
});

// "לא בנוח" — מתמטיקה: הורדת רמה בפרק הבא; שאר: החלפת שאלה
app.post('/api/not-comfortable', authExaminee, (req, res) => {
  const { round } = req.body || {};
  const slot = getSlot(req.examinee.code, round);
  if (!slot || slot.kind !== 'chapter') return res.status(400).json({ error: 'אין פרק פעיל בסבב זה.' });
  db.prepare('UPDATE slots SET not_comfortable = 1 WHERE code = ? AND round = ?').run(req.examinee.code, round);
  logEvent(req.examinee.code, 'not_comfortable', `${slot.subject} round ${round}`);

  if (slot.subject === 'מתמטיקה') {
    // מורידים רמה בפרק המתמטיקה הבא (אם קיים)
    const nextMath = db.prepare(
      "SELECT * FROM slots WHERE code = ? AND round > ? AND subject = 'מתמטיקה' AND kind = 'chapter' ORDER BY round ASC LIMIT 1"
    ).get(req.examinee.code, round);
    if (nextMath) {
      const newLevel = schedule.lowerLevel(nextMath.level);
      const ch = content.findChapter('מתמטיקה', newLevel, nextMath.variant_index);
      db.prepare('UPDATE slots SET level = ?, chapter_id = ? WHERE code = ? AND round = ?')
        .run(newLevel, ch ? ch.chapter_id : nextMath.chapter_id, req.examinee.code, nextMath.round);
      return res.json({ ok: true, effect: 'level_down', next_round: nextMath.round, new_level: newLevel });
    }
    return res.json({ ok: true, effect: 'noted', message: 'נרשם. אין פרק מתמטיקה נוסף להורדת רמה.' });
  }
  // שאר המקצועות — החלפה לנושא אחר מהפול (אם קיים)
  const next = pickSwapChapter(req.examinee.code, slot, round);
  if (next) {
    db.prepare('UPDATE slots SET chapter_id = ?, level = ?, variant_index = 0 WHERE code = ? AND round = ?')
      .run(next.chapter_id, next.level || slot.level, req.examinee.code, round);
    return res.json({ ok: true, effect: 'swap', state: buildExamineeState(getExamineeByCode.get(req.examinee.code)) });
  }
  return res.json({ ok: true, effect: 'noted', message: 'נרשם. אין נושא חלופי זמין כרגע.' });
});

// הגשת פרק — הנבחן סיים והגיש. המשבצת נסגרת והוא ממתין לסבב הבא.
app.post('/api/submit-slot', authExaminee, (req, res) => {
  const { round } = req.body || {};
  const r = Number(round) || currentRunningRound();
  const slot = getSlot(req.examinee.code, r);
  if (!slot || slot.kind !== 'chapter') return res.status(400).json({ error: 'אין פרק פעיל להגשה.' });
  db.prepare('UPDATE slots SET status = ? WHERE code = ? AND round = ?').run('done', req.examinee.code, r);
  logEvent(req.examinee.code, 'submit', `round ${r}`);
  // גוגל שיטס לייב: התשובות המלאות של הפרק בכל הגשה (צפייה חיה + עותק חיצוני)
  pushChapterAnswers(req.examinee, slot);
  res.json({ ok: true, state: buildExamineeState(getExamineeByCode.get(req.examinee.code)) });
});

// דיווח אירוע (מעבר טאב / יציאת מיקוד / ניסיון הדבקה) — אנטי-העתקה קל
app.post('/api/event', authExaminee, (req, res) => {
  const { type, detail } = req.body || {};
  if (!type) return res.status(400).json({ error: 'חסר סוג אירוע.' });
  logEvent(req.examinee.code, type, detail);
  res.json({ ok: true });
});

// ============================================================
//  נקודות קצה — בוחן
// ============================================================

app.post('/api/examiner/login', (req, res) => {
  const { password } = req.body || {};
  if (String(password || '') !== EXAMINER_PASSWORD) {
    return res.status(401).json({ error: 'סיסמת בוחן שגויה.' });
  }
  const token = newToken();
  examinerTokens.add(token);
  res.json({ token });
});

// ============================================================
//  מסך המראיין
// ============================================================
// רשימת המראיינים של היום — לבחירת שם במסך הכניסה (שמות וחדרים בלבד).
app.get('/api/interviewers-public', (req, res) => {
  const rows = db.prepare('SELECT id, name, room FROM interviewers WHERE day_id = ? AND active = 1 ORDER BY name').all(activeDayId());
  res.json({ interviewers: rows });
});

app.post('/api/interviewer/login', (req, res) => {
  const { password, interviewer_id } = req.body || {};
  if (String(password || '') !== INTERVIEWER_PASSWORD) return res.status(401).json({ error: 'סיסמה שגויה.' });
  const iv = db.prepare('SELECT * FROM interviewers WHERE id = ? AND day_id = ?').get(Number(interviewer_id), activeDayId());
  if (!iv) return res.status(404).json({ error: 'יש לבחור שם מהרשימה.' });
  const token = newToken();
  interviewerTokens.set(token, iv.id);
  res.json({ token, interviewer: { id: iv.id, name: iv.name, room: iv.room || '', brief: iv.brief || '' } });
});

// הלו"ז של המראיין: הסבב הנוכחי (מתי התחיל/מסתיים) + מי אצלו בכל סבב + בריף
app.get('/api/interviewer/schedule', authInterviewer, (req, res) => {
  const iv = req.interviewer;
  const running = currentRunningRound();
  const roundsArr = db.prepare('SELECT round, state, started_at FROM day_rounds WHERE day_id = ? ORDER BY round').all(activeDayId());

  // חלון הזמן של הסבב הרץ — מ-`computeRoundTimer`, אותו מקור בדיוק כמו במסך
  // המנהל ובמסך הנבחן. ⚠ בעבר זה נגזר מ-MIN(slots.started_at), כלומר מהרגע
  // שהנבחן הראשון פתח את הפרק, ולכן הראה מספר אחר מזה של המנהל.
  const rt = computeRoundTimer(activeDayId(), running);
  const current = running ? {
    round: running,
    started_at: rt.started_at,
    ends_at: rt.ends_at,
    duration_sec: rt.duration_sec,
    remaining_sec: rt.remaining_sec,
    overtime_sec: rt.overtime_sec,
    state: rt.state,
  } : null;

  const marks = db.prepare(`SELECT m.round, m.code, e.name, e.interview_brief, e.interviewed, e.in_interview, e.status
                            FROM interview_marks m JOIN examinees e ON e.code = m.code
                            WHERE m.interviewer_id = ? AND e.day_id = ?
                            ORDER BY m.round, e.name`).all(iv.id, activeDayId());
  const schedule_rows = marks.map((m) => {
    const st = roundsArr.find((r) => r.round === m.round);
    const rs = st ? st.state : 'planned';
    let status = 'ממתין';
    if (m.in_interview) status = 'אצלי כרגע';
    else if (m.interviewed) status = 'הסתיים';
    else if (rs === 'running') status = 'הסבב שלי — רץ עכשיו';
    else if (rs === 'ended') status = 'הסתיים';
    return {
      round: m.round, code: m.code, name: m.name, brief: m.interview_brief || '',
      status, round_state: rs, left: m.status === 'left',
      in_interview: !!m.in_interview, interviewed: !!m.interviewed,
    };
  });

  const day = activeDay();
  res.json({
    interviewer: { id: iv.id, name: iv.name, room: iv.room || '', brief: iv.brief || '' },
    day: day ? { name: day.name, title: day.title, total_rounds: day.total_rounds, phase: day.phase } : null,
    running, rounds: roundsArr, current, schedule: schedule_rows,
    server_now: now(),
    my_swaps: db.prepare('SELECT id, round, code, requested_change, status, created_at FROM interview_swap_requests WHERE interviewer_id = ? AND day_id = ? ORDER BY id DESC LIMIT 20').all(iv.id, activeDayId()),
  });
});

// בקשת החלפה — המראיין מבקש, המנהל מאשר (ואז זה מבוצע בפועל)
app.post('/api/interviewer/swap-request', authInterviewer, (req, res) => {
  const b = req.body || {};
  const txt = String(b.requested_change || '').trim();
  if (!txt) return res.status(400).json({ error: 'יש לכתוב מה מבקשים לשנות.' });
  db.prepare(`INSERT INTO interview_swap_requests (day_id, interviewer_id, code, round, requested_change, status, created_at)
              VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(
    activeDayId(), req.interviewer.id, b.code || null, b.round ? Number(b.round) : null, txt.slice(0, 1000), now());
  logEvent(b.code || null, 'swap_request', req.interviewer.name + ': ' + txt.slice(0, 120));
  res.json({ ok: true });
});

// ============================================================
//  ניהול ימי הערכה («הקם יום הערכה»)
// ============================================================
// רשימת הימים + היום הפעיל. לכל יום מוצג כמה נבחנים יש בו.
app.get('/api/examiner/days', authExaminer, (req, res) => {
  const days = db.prepare('SELECT * FROM days ORDER BY id DESC').all().map((d) => ({
    ...d,
    examinees: db.prepare('SELECT COUNT(*) AS c FROM examinees WHERE day_id = ?').get(d.id).c,
    // האם קיים צילום בדיקה ליום הזה (לארכיון — כדי לדעת מה כבר נשלח לבדיקה)
    has_snapshot: db.prepare('SELECT COUNT(*) AS c FROM grading_cohorts WHERE day_id = ?').get(d.id).c > 0,
  }));
  res.json({ days, active_day_id: activeDayId(), min_rounds: MIN_ROUNDS, max_rounds: MAX_ROUNDS });
});

// יצירת יום הערכה חדש (ומיד הופך לפעיל) — הנתונים של הימים הקודמים נשמרים במלואם.
app.post('/api/examiner/create-day', authExaminer, (req, res) => {
  const b = req.body || {};
  const name = normName(b.name) || ('יום הערכה ' + new Date().toLocaleDateString('he-IL'));
  let n = Math.round(Number(b.total_rounds)) || 5;
  n = Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, n));
  const title = String(b.title || 'יום הערכה תשפ״ז').slice(0, 120);
  makeBackup('create-day');
  const info = db.prepare('INSERT INTO days (name, title, total_rounds, phase, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, title, n, 'registration', 'open', now());
  const dayId = Number(info.lastInsertRowid);
  seedDayRounds(dayId, n, false);
  setConfig('active_day_id', dayId);
  setExamEnded(false);
  logEvent(null, 'create_day', name + ' · ' + n + ' סבבים');
  res.json({ ok: true, day_id: dayId });
});

// מעבר בין ימים (לצפייה/עריכה של יום קודם)
app.post('/api/examiner/set-active-day', authExaminer, (req, res) => {
  const id = Number((req.body || {}).day_id);
  const d = db.prepare('SELECT id FROM days WHERE id = ?').get(id);
  if (!d) return res.status(404).json({ error: 'יום לא נמצא.' });
  setConfig('active_day_id', id);
  res.json({ ok: true, active_day_id: id });
});

// עריכת היום הפעיל: שם, כותרת לנבחן, מספר סבבים (3–5), שלב היום.
app.post('/api/examiner/update-day', authExaminer, (req, res) => {
  const b = req.body || {};
  const day = activeDay();
  if (!day) return res.status(400).json({ error: 'אין יום פעיל.' });
  try {
    if (b.total_rounds != null && Number(b.total_rounds) !== Number(day.total_rounds)) {
      let n = Math.round(Number(b.total_rounds));
      if (!(n >= MIN_ROUNDS && n <= MAX_ROUNDS)) {
        return res.status(400).json({ error: 'מספר הסבבים חייב להיות בין ' + MIN_ROUNDS + ' ל-' + MAX_ROUNDS + '. תנאי בסיס: פרק «מידע כללי», פרק מקצוע אחד לפחות, וריאיון.' });
      }
      // מספר הסבבים נקבע בהקמת היום. מרגע שהמבחן התחיל — נעול, כדי שלא ישתבש
      // לנבחנים באמצע. (לשיבוץ נבחן בודד לסבב שרץ יש «קדם לפעילות הבאה».)
      if (latestActiveRound() > 0) {
        return res.status(400).json({ error: 'המבחן כבר התחיל — מספר הסבבים נקבע בהקמת היום ואי אפשר לשנותו עכשיו. לשיבוץ נבחן בודד לסבב הרץ: «כרטיס» → «קדם לפעילות הבאה».' });
      }
      makeBackup('set-rounds');
      reconcileRounds(day.id, n);   // זורק שגיאה מסבירה אם אי אפשר להקטין
      db.prepare('UPDATE days SET total_rounds = ? WHERE id = ?').run(n, day.id);
    }
    if (b.name != null) db.prepare('UPDATE days SET name = ? WHERE id = ?').run(normName(b.name).slice(0, 120), day.id);
    if (b.title != null) db.prepare('UPDATE days SET title = ? WHERE id = ?').run(String(b.title).slice(0, 120), day.id);
    // הודעת מסך הסיום — ניתנת לעריכה גם בלייב (הנבחנים מתעדכנים דרך ה-polling)
    if (b.finish_message != null) db.prepare('UPDATE days SET finish_message = ? WHERE id = ?').run(String(b.finish_message).slice(0, 600), day.id);
    if (b.phase != null) {
      // שני שלבים בלבד: הרשמה ⇄ פתוח.
      const ph = b.phase === 'open' ? 'open' : 'registration';
      // חזרה לשלב הרשמה אסורה אחרי שהתחילו — אחרת מי שבאמצע פרק נזרק למסך «נרשמת»
      // (בדיקת ההרשמה ב-buildExamineeState קודמת לבדיקת הפרק הפעיל).
      if (ph === 'registration' && day.phase === 'open') {
        if (currentRunningRound()) {
          return res.status(400).json({ error: 'סבב ' + currentRunningRound() + ' פועל כרגע — אי אפשר לחזור לשלב הרשמה. סיימו את הסבב קודם.' });
        }
        const withSlots = db.prepare('SELECT COUNT(*) AS c FROM slots WHERE code IN (SELECT code FROM examinees WHERE day_id = ?)').get(day.id).c;
        if (withSlots > 0) {
          return res.status(400).json({ error: 'המבחן כבר התחיל (יש נבחנים משובצים) — אי אפשר לחזור לשלב הרשמה. אם רוצים להתחיל מאפס: «אפס יום מלא».' });
        }
      }
      db.prepare('UPDATE days SET phase = ? WHERE id = ?').run(ph, day.id);
    }
    res.json({ ok: true, day: activeDay() });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// ============================================================
//  «שמור יום» — סוגר את היום ומייצר את הצילום הראשי לבדיקה
// ============================================================
// פעולה אחת בסוף היום: גיבוי → סיום המבחן → סגירת סבב פעיל →
// צילום ראשי לבדיקה (עותק קפוא) → סגירת היום לארכיון.
app.post('/api/examiner/save-day', authExaminer, (req, res) => {
  const day = activeDay();
  if (!day) return res.status(400).json({ error: 'אין יום פעיל.' });
  makeBackup('pre-save-day');
  try {
    // 1) הצילום הראשי לבדיקה — **קודם כול**, כדי שכשל לא ישאיר את היום במצב חצי.
    //    ⚠ בעבר סיום הסבב רץ לפניו, בניגוד להערה: צילום שנכשל השאיר את הסבב
    //    סגור ואת היום בלי צילום. התשובות אינן תלויות בסטטוס המשבצת, ולכן
    //    צילום לפני סגירת הסבב תופס בדיוק את אותן תשובות.
    const snap = createSnapshot(day.name, { primary: true });
    // 2) סיום סבב פעיל אם יש (כדי שכל המשבצות ייסגרו)
    const running = currentRunningRound();
    if (running) {
      db.prepare("UPDATE examinees SET interviewed = 1 WHERE day_id = ? AND code IN (SELECT code FROM slots WHERE round = ? AND kind = 'interview')").run(day.id, running);
      db.prepare("UPDATE slots SET status = 'done' WHERE round = ? AND status != 'done'" + DAY_SCOPE).run(running, day.id);
      db.prepare("UPDATE day_rounds SET state = 'ended' WHERE day_id = ? AND round = ?").run(day.id, running);
    }
    // 3) המבחן הסתיים (פר-יום) — כל הנבחנים רואים את מסך הסיום
    setExamEnded(true);
    // 4) היום עובר לארכיון
    db.prepare("UPDATE days SET status = 'closed' WHERE id = ?").run(day.id);
    logEvent(null, 'save_day', day.name + ' → צילום #' + snap.cohort_id);
    res.json({
      ok: true, day_name: day.name, cohort_id: snap.cohort_id, cohort_name: snap.name,
      reused: snap.reused, examinees: snap.examinees, answers: snap.answers, teachItems: snap.teachItems,
      zero_answers: snap.zero_answers || [], ended_round: running || null,
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// מה נשמר מהיום הזה — כדי שתמיד יהיה ברור מה קיים ואיפה
app.get('/api/examiner/day-saves', authExaminer, (req, res) => {
  const dayId = activeDayId();
  const day = activeDay();
  const cohorts = db.prepare('SELECT * FROM grading_cohorts WHERE day_id = ? ORDER BY id DESC').all(dayId).map((c) => ({
    id: c.id, name: c.name, created_at: c.created_at, is_primary: !!c.is_primary, status: c.status,
    examinees: db.prepare('SELECT COUNT(*) AS c FROM grading_examinees WHERE cohort_id = ?').get(c.id).c,
    answers: db.prepare('SELECT COUNT(*) AS c FROM grading_answers WHERE cohort_id = ?').get(c.id).c,
  }));
  const primary = cohorts.find((c) => c.is_primary) || null;
  // מה יש כרגע בצד החי (לפני צילום)
  const liveExaminees = db.prepare('SELECT COUNT(*) AS c FROM examinees WHERE day_id = ?').get(dayId).c;
  const liveAnswers = db.prepare('SELECT COUNT(*) AS c FROM answers WHERE code IN (SELECT code FROM examinees WHERE day_id = ?)').get(dayId).c;
  // ⚠ תשובות שהגיעו *אחרי* הצילום (טלפון שחזר לרשת ושלח outbox תקוע) אינן
  // בצילום, ולכן לא ינוקדו לעולם. שני המספרים הוצגו זה לצד זה בלי השוואה,
  // שניהם בירוק. עכשיו יש דגל מפורש שהמסך הופך לאזהרה אדומה + «צלם שוב».
  const stale = !!(primary && (liveAnswers > primary.answers || liveExaminees > primary.examinees));
  res.json({
    day: day ? { id: day.id, name: day.name, status: day.status, exam_ended: !!day.exam_ended } : null,
    primary, cohorts,
    live: { examinees: liveExaminees, answers: liveAnswers },
    stale: stale,
    stale_answers: stale ? liveAnswers - primary.answers : 0,
    stale_examinees: stale ? liveExaminees - primary.examinees : 0,
    db_path: DB_PATH,
  });
});

// סגירת יום (ארכיון) / פתיחה מחדש. הנתונים נשארים נגישים במלואם.
app.post('/api/examiner/set-day-status', authExaminer, (req, res) => {
  const b = req.body || {};
  const id = Number(b.day_id);
  const d = db.prepare('SELECT * FROM days WHERE id = ?').get(id);
  if (!d) return res.status(404).json({ error: 'יום לא נמצא.' });
  const st = b.status === 'closed' ? 'closed' : 'open';
  // ⚠ פתיחה מחדש חייבת לבטל גם «המבחן הסתיים» — אחרת היום נראה פתוח למנהל
  // אבל כל הנבחנים (וכל מי שנרשם) ממשיכים לראות את מסך הסיום.
  if (st === 'open') db.prepare("UPDATE days SET status = 'open', exam_ended = 0 WHERE id = ?").run(id);
  else db.prepare("UPDATE days SET status = 'closed' WHERE id = ?").run(id);
  logEvent(null, 'day_status', d.name + ' → ' + st);
  res.json({ ok: true, status: st });
});

// מחיקת יום: מוחקת את נתוני היום החי (נבחנים→CASCADE תשובות/משבצות, מראיינים,
// סבבים, בקשות החלפה). ⚠ טבלאות grading_* (צילומי מצב לבדיקה) *לא* נמחקות —
// ציונים שהופקו נשמרים. אם זה היום הפעיל, עוברים ליום אחר.
app.post('/api/examiner/delete-day', authExaminer, (req, res) => {
  const id = Number((req.body || {}).day_id);
  const d = db.prepare('SELECT * FROM days WHERE id = ?').get(id);
  if (!d) return res.status(404).json({ error: 'יום לא נמצא.' });
  const total = db.prepare('SELECT COUNT(*) AS c FROM days').get().c;
  if (total <= 1) return res.status(400).json({ error: 'זה היום היחיד במערכת — צרו יום חדש לפני שמוחקים אותו.' });
  makeBackup('pre-delete-day');
  const n = db.prepare('SELECT COUNT(*) AS c FROM examinees WHERE day_id = ?').get(id).c;
  db.prepare('DELETE FROM interview_marks WHERE code IN (SELECT code FROM examinees WHERE day_id = ?)').run(id);
  db.prepare('DELETE FROM examinees WHERE day_id = ?').run(id);   // slots+answers ב-CASCADE
  db.prepare('DELETE FROM interviewers WHERE day_id = ?').run(id);
  db.prepare('DELETE FROM day_rounds WHERE day_id = ?').run(id);
  db.prepare('DELETE FROM interview_swap_requests WHERE day_id = ?').run(id);
  db.prepare('DELETE FROM days WHERE id = ?').run(id);
  if (activeDayId() === id) {
    const other = db.prepare('SELECT id FROM days ORDER BY id DESC LIMIT 1').get();
    if (other) setConfig('active_day_id', other.id);
  }
  logEvent(null, 'delete_day', d.name + ' · ' + n + ' נבחנים');
  res.json({ ok: true, removed_examinees: n, active_day_id: activeDayId() });
});

app.get('/api/examiner/rounds', authExaminer, (req, res) => {
  res.json({ rounds: db.prepare('SELECT round, code, released, released_at FROM day_rounds WHERE day_id = ? ORDER BY round').all(activeDayId()) });
});

app.post('/api/examiner/set-round-code', authExaminer, (req, res) => {
  const { round, code } = req.body || {};
  db.prepare('UPDATE day_rounds SET code = ? WHERE day_id = ? AND round = ?').run(String(code || ''), activeDayId(), Number(round));
  res.json({ ok: true });
});

// פתיחת משתמש לנבחן מראש (יחיד). אם לא נבחרו מקצועות — הנבחן ישלים בעצמו בכניסה.
app.post('/api/examiner/add-examinee', authExaminer, (req, res) => {
  const { name, code, subjects, math_level, interview_round } = req.body || {};
  if (!name) return res.status(400).json({ error: 'נדרש שם.' });
  const cleanName = String(name).trim();
  const cleanPin = String(code == null ? '' : code).trim(); // קוד אישי אופציונלי — אפשר לפתוח לפי שם בלבד
  if (findByName(cleanName)) return res.status(409).json({ error: 'השם כבר קיים: ' + cleanName });
  const chosen = Array.isArray(subjects) ? subjects.filter(Boolean).slice(0, 4) : [];
  const mathLevel = chosen.includes('מתמטיקה') ? (math_level || '5') : null;
  const internalCode = genCode();
  db.prepare(`INSERT INTO examinees (code, name, pin, token, declaration, subjects, math_level, interview_round, created_at, status, day_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`).run(
    internalCode, cleanName, cleanPin, newToken(), JSON.stringify(null), JSON.stringify(chosen), mathLevel, now(),
    chosen.length ? 'active' : 'registered', activeDayId());
  const r = Number(interview_round);
  if (r >= 1 && r <= totalRounds()) db.prepare('INSERT OR IGNORE INTO interview_marks (round, code) VALUES (?, ?)').run(r, internalCode);
  logEvent(internalCode, 'preregister', cleanName);
  res.json({ ok: true, code: internalCode, needs_setup: chosen.length === 0 });
});

// פתיחת משתמשים מרשימה. פורמט כל שורה: "שם, קוד" או "שם, קוד, סבב-ריאיון" (סבב אופציונלי 1..5).
// בלי סבב — נשאר לא-משובץ, כדי שהמנהל ישבץ לפי שם בפאנל התכנון.
app.post('/api/examiner/add-examinees-bulk', authExaminer, (req, res) => {
  const text = String((req.body && req.body.text) || '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let added = 0; const skipped = [];
  for (const line of lines) {
    const parts = line.split(/[,\t;]/).map((s) => s.trim());
    const name = parts[0], pin = parts[1] || ''; // קוד אישי אופציונלי
    const roundRaw = parts[2] !== undefined ? Number(parts[2]) : null;
    const iRound = roundRaw && roundRaw >= 1 && roundRaw <= totalRounds() ? roundRaw : null;
    if (!name) { skipped.push(line + ' (חסר שם)'); continue; }
    if (findByName(name)) { skipped.push(name + ' (כבר קיים)'); continue; }
    const internalCode = genCode();
    db.prepare(`INSERT INTO examinees (code, name, pin, token, declaration, subjects, math_level, interview_round, created_at, status, day_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'registered', ?)`).run(
      internalCode, name, pin, newToken(), JSON.stringify(null), JSON.stringify([]), null, now(), activeDayId());
    if (iRound) db.prepare('INSERT OR IGNORE INTO interview_marks (round, code) VALUES (?, ?)').run(iRound, internalCode);
    added++;
  }
  logEvent(null, 'bulk_preregister', `נוספו ${added}`);
  res.json({ ok: true, added, skipped });
});

// סימון/ביטול נבחן לריאיון בסבב מסוים (רק כשהסבב עדיין 'planned')
app.post('/api/examiner/mark-interview', authExaminer, (req, res) => {
  const { code, round, on } = req.body || {};
  // ⚠ בלי הגנת היום, סימון ריאיון לנבחן של יום אחר *מחק* לו את התכנון הקיים,
  // כי שורת הניקוי למטה רצה על הסבבים של היום הפעיל.
  const _g = examineeOfActiveDay(code);
  if (_g.err) return res.status(_g.err).json({ error: _g.msg });
  const r = Number(round);
  if (!r || r < 1 || r > totalRounds()) return res.status(400).json({ error: 'מספר סבב לא תקין.' });
  if (roundState(r) !== 'planned') return res.status(400).json({ error: 'אפשר לסמן רק סבב שעדיין לא התחיל.' });
  const ex = getExamineeByCode.get(code);
  if (!ex) return res.status(404).json({ error: 'נבחן לא נמצא.' });
  if (on) {
    if (hasInterviewed(code)) return res.json({ ok: false, warn: 'נבחן זה כבר התראיין — אין צורך לסמן שוב.' });
    db.prepare('INSERT OR IGNORE INTO interview_marks (round, code) VALUES (?, ?)').run(r, code);
    // ריאיון פעם אחת: מסירים סימון מכל סבב planned אחר
    db.prepare("DELETE FROM interview_marks WHERE code = ? AND round != ? AND round IN (SELECT round FROM day_rounds WHERE day_id = ? AND state = 'planned')").run(code, r, activeDayId());
  } else {
    db.prepare('DELETE FROM interview_marks WHERE round = ? AND code = ?').run(r, code);
  }
  logEvent(code, 'mark_interview', `round ${r} ${on ? 'on' : 'off'}`);
  res.json({ ok: true });
});

// העלאת לוח תכנון בהדבקה: כל שורה "קוד/שם, סבב" → מסמן ריאיונות מראש
app.post('/api/examiner/set-interview-plan', authExaminer, (req, res) => {
  const lines = String((req.body && req.body.text) || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let marked = 0; const skipped = [];
  for (const line of lines) {
    const parts = line.split(/[,\t;]/).map((s) => s.trim());
    const key = parts[0]; const r = Number(parts[1]);
    if (!key || !(r >= 1 && r <= totalRounds())) { skipped.push(line); continue; }
    const ex = findByName(key) || getExamineeByCode.get(String(key));
    if (!ex) { skipped.push(line + ' (לא נמצא)'); continue; }
    // findByName כבר מוגבל ליום הפעיל; חיפוש לפי code עוקף אותו.
    if (ex.day_id !== activeDayId()) { skipped.push(line + ' (שייך ליום אחר)'); continue; }
    if (roundState(r) !== 'planned') { skipped.push(line + ' (הסבב כבר התחיל)'); continue; }
    db.prepare('INSERT OR IGNORE INTO interview_marks (round, code) VALUES (?, ?)').run(r, ex.code);
    marked++;
  }
  logEvent(null, 'set_interview_plan', `סומנו ${marked}`);
  res.json({ ok: true, marked, skipped });
});

// הסרת נבחן (שימושי לניקוי נבחני בדיקה)
app.post('/api/examiner/remove-examinee', authExaminer, (req, res) => {
  const { code } = req.body || {};
  // ⚠ שומר יום: מחיקת נבחן של יום אחר בטעות תמחק גם את כל תשובותיו (CASCADE)
  const _rg = examineeOfActiveDay(code);
  if (_rg.err) return res.status(_rg.err).json({ error: _rg.msg });
  makeBackup('pre-remove-examinee');
  db.prepare('DELETE FROM examinees WHERE code = ?').run(code); // slots + answers נמחקים ב-CASCADE
  logEvent(null, 'remove_examinee', code);
  res.json({ ok: true });
});

// הסרת כל הנבחנים בבת אחת (מחיקה מלאה — slots/answers/interview_marks נמחקים ב-CASCADE).
// תכנון הסבבים (טבלת rounds) נשמר. גיבוי אוטומטי לפני.
app.post('/api/examiner/remove-all-examinees', authExaminer, (req, res) => {
  makeBackup('pre-remove-all-examinees');
  const n = db.prepare('SELECT COUNT(*) AS c FROM examinees WHERE day_id = ?').get(activeDayId()).c;
  db.prepare('DELETE FROM examinees WHERE day_id = ?').run(activeDayId());
  logEvent(null, 'remove_all_examinees', String(n));
  res.json({ ok: true, removed: n });
});

// עריכת שם / קוד אישי של נבחן (המנהל מתקן טעויות). המזהה הפנימי (code) לא משתנה — אין פגיעה בנתונים.
app.post('/api/examiner/edit-examinee', authExaminer, (req, res) => {
  const { code, name, pin } = req.body || {};
  const _g = examineeOfActiveDay(code);
  if (_g.err) return res.status(_g.err).json({ error: _g.msg });
  const ex = _g.ex;
  if (name !== undefined) {
    const cleanName = normName(name);
    if (!cleanName) return res.status(400).json({ error: 'השם לא יכול להיות ריק.' });
    const clash = findByName(cleanName);
    if (clash && clash.code !== ex.code) return res.status(409).json({ error: 'כבר קיים נבחן אחר בשם הזה.' });
    db.prepare('UPDATE examinees SET name = ? WHERE code = ?').run(cleanName, ex.code);
  }
  if (pin !== undefined) {
    db.prepare('UPDATE examinees SET pin = ? WHERE code = ?').run(String(pin).trim(), ex.code);
  }
  logEvent(ex.code, 'edit_examinee', normName(name !== undefined ? name : ex.name));
  res.json({ ok: true });
});

// התחלת סבב — בונה חי לכל נבחן פעיל את המשבצת שלו (ריאיון לפי סימון, אחרת הפרק הבא)
app.post('/api/examiner/start-round', authExaminer, (req, res) => {
  const r = Number((req.body || {}).round);
  if (!Number.isInteger(r) || r < 1 || r > totalRounds()) return res.status(400).json({ error: 'מספר סבב לא תקין.' });
  if (roundState(r) !== 'planned') return res.status(400).json({ error: 'הסבב כבר התחיל.' });
  if (r > 1 && roundState(r - 1) !== 'ended') return res.status(400).json({ error: `יש לסיים קודם את סבב ${r - 1}.` });
  const running = currentRunningRound();
  if (running) return res.status(400).json({ error: `סבב ${running} עדיין פועל — סיים אותו קודם.` });

  // רשת ביטחון: אם היום עדיין בשלב ההרשמה — פותחים אותו. אחרת הנבחנים היו
  // נשארים תקועים על מסך «נרשמת בהצלחה» גם אחרי שהסבב התחיל.
  if (dayPhase() === 'registration') {
    db.prepare("UPDATE days SET phase = 'open' WHERE id = ?").run(activeDayId());
    logEvent(null, 'auto_open_day', 'נפתח אוטומטית בהתחלת סבב ' + r);
  }

  // כל מי שלא עזב — כולל 'registered' (נרשם בבוקר וטרם בחר מקצועות).
  // ריאיון אינו זקוק למקצועות, ולכן מי שמסומן לריאיון מקבל משבצת בכל מקרה.
  const examinees = db.prepare("SELECT * FROM examinees WHERE status != 'left' AND day_id = ?").all(activeDayId());
  const insSlot = db.prepare(`INSERT INTO slots (code, round, kind, subject, level, chapter_id, duration_sec)
                              VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(code, round) DO NOTHING`);
  let chapters = 0, interviews = 0;
  for (const ex of examinees) {
    const hasSubjects = JSON.parse(ex.subjects || '[]').length > 0;
    const markedForInterview = isMarkedInterview(r, ex.code) && !hasInterviewed(ex.code);
    // ריאיון קודם — ולא תלוי בבחירת מקצועות
    if (markedForInterview) {
      insSlot.run(ex.code, r, 'interview', null, null, null, SLOT_DURATION_SEC);
      interviews++;
      continue;
    }
    if (!hasSubjects) continue; // אין ריאיון ואין מקצועות — אין משבצת (ימשיך לבחור)
    const act = resolveActivity(ex, r);
    if (!act) continue; // idle — אין משבצת
    insSlot.run(ex.code, r, act.kind, act.subject, act.level, act.chapter_id, SLOT_DURATION_SEC);
    if (act.kind === 'interview') interviews++; else chapters++;
  }
  // שעון הסבב מתחיל כאן — זו נקודת האמת היחידה. ההשהיה מתאפסת למקרה שהסבב
  // אופס וחזר להתחיל אחרי «השהה את כולם».
  db.prepare(`UPDATE day_rounds SET state = 'running', started_at = ?, released = 1, released_at = ?,
              duration_sec = ?, paused = 0, paused_at = NULL, paused_accum_sec = 0
              WHERE day_id = ? AND round = ?`).run(now(), now(), SLOT_DURATION_SEC, activeDayId(), r);
  logEvent(null, 'start_round', `round ${r} · ${interviews} ריאיון · ${chapters} פרק`);
  // מי שטרם בחר מקצועות לא קיבל פרק — אבל יצטרף אוטומטית ברגע שיבחר (תיקון עצמי ב-complete-setup)
  const noSubjects = examinees
    .filter((e) => JSON.parse(e.subjects || '[]').length === 0 && !isMarkedInterview(r, e.code))
    .map((e) => e.name);
  res.json({ ok: true, round: r, interviews, chapters, no_subjects: noSubjects });
});

// סיום סבב — כל המשבצות נסגרות (done), הסבב עובר ל-ended
app.post('/api/examiner/end-round', authExaminer, (req, res) => {
  const r = Number((req.body || {}).round) || currentRunningRound();
  if (!r || roundState(r) !== 'running') return res.status(400).json({ error: 'אין סבב פעיל לסיום.' });
  makeBackup('pre-end-round');
  // מי שהמשבצת שלו בסבב זה היא ריאיון — מסומן "התראיין"
  db.prepare("UPDATE examinees SET interviewed = 1 WHERE day_id = ? AND code IN (SELECT code FROM slots WHERE round = ? AND kind = 'interview')").run(activeDayId(), r);
  // רשת ביטחון: נבחן שנשלח לריאיון-חי (in_interview) ולא הוחזר ידנית — בסיום הסבב נחשב כמי שהתראיין
  // ומשוחרר, כדי שלא ייתקע על מסך הריאיון בסבב הבא.
  db.prepare("UPDATE examinees SET interviewed = 1, in_interview = 0 WHERE in_interview = 1 AND day_id = ?").run(activeDayId());
  // גוגל שיטס: לדחוף את התשובות של מי שלא לחץ "הגש" *לפני* סגירת הסבב —
  // כך אף תשובה לא נעדרת מהגיליון, ובלי כפילויות (המוגשים כבר 'done' ונדחפו בהגשה).
  if (SHEETS_WEBHOOK_URL) {
    const pending = db.prepare("SELECT * FROM slots WHERE round = ? AND kind = 'chapter' AND status != 'done'" + DAY_SCOPE).all(r, activeDayId());
    for (const s of pending) {
      const ex = getExamineeByCode.get(s.code);
      if (ex) pushChapterAnswers(ex, s);
    }
  }
  // מי נחתך באמצע — נאסף *לפני* הסגירה, כי אחרי ה-UPDATE אי אפשר להבדיל
  // בין מי שהגיש בעצמו לבין מי שהסבב נסגר עליו. התשובות עצמן נשמרות תמיד
  // (`answers` ממופתח לפי chapter_id, לא לפי סבב), רק המשבצת נסגרת.
  const unsubmitted = db.prepare(`SELECT s.code, s.subject, e.name,
                                    (SELECT COUNT(*) FROM answers a WHERE a.code = s.code AND a.chapter_id = s.chapter_id) AS answered
                                  FROM slots s JOIN examinees e ON e.code = s.code
                                  WHERE s.round = ? AND s.kind = 'chapter' AND s.status != 'done' AND e.day_id = ?
                                  ORDER BY e.name`).all(r, activeDayId());
  db.prepare("UPDATE slots SET status = 'done' WHERE round = ? AND status != 'done'" + DAY_SCOPE).run(r, activeDayId());
  db.prepare("UPDATE day_rounds SET state = 'ended' WHERE day_id = ? AND round = ?").run(activeDayId(), r);
  logEvent(null, 'end_round', String(r) + (unsubmitted.length ? ` · ${unsubmitted.length} טרם הגישו: ${unsubmitted.map((u) => u.name).join(', ')}` : ' · כולם הגישו'));
  res.json({ ok: true, round: r, unsubmitted, unsubmitted_count: unsubmitted.length });
});

// איפוס סבב — מבטל את הסבב הנוכחי (מוחק את המשבצות שלו) ומחזיר ל-planned. התשובות נשמרות.
app.post('/api/examiner/reset-round', authExaminer, (req, res) => {
  const r = Number((req.body || {}).round);
  if (!r || roundState(r) === 'planned') return res.status(400).json({ error: 'אין מה לאפס בסבב זה.' });
  if (latestActiveRound() !== r) return res.status(400).json({ error: `אפס קודם את סבב ${latestActiveRound()} (המאוחר יותר).` });
  makeBackup('pre-reset-round');
  // ביטול סימון "התראיין" למי שהריאיון שלו היה בסבב הזה
  db.prepare("UPDATE examinees SET interviewed = 0 WHERE day_id = ? AND code IN (SELECT code FROM slots WHERE round = ? AND kind = 'interview')").run(activeDayId(), r);
  // ⚠ וגם לשחרר את מי שהיה "בריאיון" — אחרת buildExamineeState בודק in_interview
  // לפני המשבצת, והנבחן היה נשאר קפוא במסך הריאיון לכל שאר היום.
  db.prepare('UPDATE examinees SET in_interview = 0 WHERE day_id = ? AND code IN (SELECT code FROM slots WHERE round = ?)').run(activeDayId(), r);
  db.prepare('DELETE FROM slots WHERE round = ?' + DAY_SCOPE).run(r, activeDayId());
  db.prepare(`UPDATE day_rounds SET state = 'planned', started_at = NULL, released = 0, released_at = NULL,
              duration_sec = NULL, paused = 0, paused_at = NULL, paused_accum_sec = 0
              WHERE day_id = ? AND round = ?`).run(activeDayId(), r);
  logEvent(null, 'reset_round', String(r));
  res.json({ ok: true, round: r });
});

// איפוס המשבצת של כל הנבחנים בסבב הרץ (טיימר מחדש)
app.post('/api/examiner/reset-all-current', authExaminer, (req, res) => {
  const r = currentRunningRound();
  if (!r) return res.status(400).json({ error: 'אין סבב פעיל.' });
  makeBackup('pre-reset-all');
  db.prepare("UPDATE slots SET started_at = NULL, status = 'pending', paused = 0, paused_at = NULL, paused_accum_sec = 0 WHERE round = ?" + DAY_SCOPE).run(r, activeDayId());
  logEvent(null, 'reset_all_current', String(r));
  res.json({ ok: true, round: r });
});

// איפוס יום מלא — מחזיר את כל הסבבים ל-planned ומוחק את כל המשבצות והתשובות (שומר נבחנים, מקצועות ותכנון)
app.post('/api/examiner/full-reset', authExaminer, (req, res) => {
  makeBackup('pre-full-reset');
  const dayId = activeDayId();
  // ⚠ מוגבל ליום הפעיל בלבד — אחרת היו נמחקות תשובות של ימים אחרים.
  db.prepare('DELETE FROM slots WHERE code IN (SELECT code FROM examinees WHERE day_id = ?)').run(dayId);
  db.prepare('DELETE FROM answers WHERE code IN (SELECT code FROM examinees WHERE day_id = ?)').run(dayId);
  db.prepare('UPDATE examinees SET interviewed = 0, in_interview = 0 WHERE day_id = ?').run(dayId);
  db.prepare(`UPDATE day_rounds SET state = 'planned', started_at = NULL, released = 0, released_at = NULL,
              duration_sec = NULL, paused = 0, paused_at = NULL, paused_accum_sec = 0
              WHERE day_id = ?`).run(dayId);
  setExamEnded(false);
  logEvent(null, 'full_reset', 'יום ' + dayId);
  res.json({ ok: true });
});

// ---------- פעולות פרטניות לנבחן בודד (טיפול במי שנפל מהקצב) ----------

// קידום נבחן בודד: משבץ אותו לסבב הרץ אם אין לו משבצת (למי שהצטרף מאוחר)
app.post('/api/examiner/advance-examinee', authExaminer, (req, res) => {
  const _g = examineeOfActiveDay((req.body || {}).code);
  if (_g.err) return res.status(_g.err).json({ error: _g.msg });
  const ex = _g.ex;
  const r = currentRunningRound();
  if (!r) return res.status(400).json({ error: 'אין סבב פעיל — התחל סבב תחילה.' });
  if (getSlot(ex.code, r)) return res.json({ ok: true, note: 'כבר משובץ בסבב הנוכחי.' });
  // ריאיון אינו זקוק למקצועות — משבצים אותו גם למי שטרם בחר.
  if (isMarkedInterview(r, ex.code) && !hasInterviewed(ex.code)) {
    db.prepare('INSERT INTO slots (code, round, kind, subject, level, chapter_id, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ex.code, r, 'interview', null, null, null, SLOT_DURATION_SEC);
    logEvent(ex.code, 'advance_examinee', `round ${r} interview`);
    return res.json({ ok: true, activity: 'interview' });
  }
  if (JSON.parse(ex.subjects || '[]').length === 0) return res.status(400).json({ error: 'הנבחן עדיין לא בחר מקצועות (ואינו מסומן לריאיון בסבב הזה).' });
  const act = resolveActivity(ex, r);
  if (!act) return res.json({ ok: false, warn: 'אין פעילות נותרת לנבחן (סיים הכול או צריך ריאיון).' });
  db.prepare('INSERT INTO slots (code, round, kind, subject, level, chapter_id, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ex.code, r, act.kind, act.subject, act.level, act.chapter_id, SLOT_DURATION_SEC);
  logEvent(ex.code, 'advance_examinee', `round ${r} ${act.kind}`);
  res.json({ ok: true, activity: act.kind });
});

// יצא לריאיון — משהה את טיימר הפרק שלו (אם יש) ומסמן "בריאיון"
app.post('/api/examiner/interview-out', authExaminer, (req, res) => {
  const _g = examineeOfActiveDay((req.body || {}).code);
  if (_g.err) return res.status(_g.err).json({ error: _g.msg });
  const ex = _g.ex;
  db.prepare('UPDATE examinees SET in_interview = 1 WHERE code = ?').run(ex.code);
  const r = currentRunningRound();
  const slot = r ? getSlot(ex.code, r) : null;
  if (slot && slot.kind === 'chapter' && !slot.paused) {
    db.prepare('UPDATE slots SET paused = 1, paused_at = ? WHERE code = ? AND round = ?').run(now(), ex.code, r);
  }
  logEvent(ex.code, 'interview_out', '');
  res.json({ ok: true });
});

// תיקון ידני של סימון «התראיין» — כדי שלחיצה בטעות תהיה הפיכה בקליק
app.post('/api/examiner/set-interviewed', authExaminer, (req, res) => {
  const b = req.body || {};
  const _g = examineeOfActiveDay(b.code);
  if (_g.err) return res.status(_g.err).json({ error: _g.msg });
  const ex = _g.ex;
  if (ex.day_id !== activeDayId()) return res.status(409).json({ error: 'הנבחן שייך ליום אחר.' });
  const v = b.value ? 1 : 0;
  db.prepare('UPDATE examinees SET interviewed = ?, in_interview = 0 WHERE code = ?').run(v, ex.code);
  logEvent(ex.code, 'set_interviewed', String(v));
  res.json({ ok: true, interviewed: !!v });
});

// חזר מריאיון — מחדש את הטיימר, מסמן "התראיין"
app.post('/api/examiner/interview-return', authExaminer, (req, res) => {
  const _g = examineeOfActiveDay((req.body || {}).code);
  if (_g.err) return res.status(_g.err).json({ error: _g.msg });
  const ex = _g.ex;
  if (ex.day_id !== activeDayId()) return res.status(409).json({ error: 'הנבחן שייך ליום אחר. החליפו יום ונסו שוב.' });
  const rNow = currentRunningRound();
  const slotNow = rNow ? getSlot(ex.code, rNow) : null;
  // ⚠ לסמן «התראיין» רק אם הוא באמת היה בריאיון — אחרת לחיצה בטעות על
  // «חזר מריאיון» הייתה מסמנת אותו כמי שהתראיין, והוא לא היה מקבל ריאיון כלל.
  const reallyWas = !!ex.in_interview || !!(slotNow && slotNow.kind === 'interview');
  if (!reallyWas) {
    db.prepare('UPDATE examinees SET in_interview = 0 WHERE code = ?').run(ex.code);
    return res.json({ ok: true, warn: 'הנבחן לא היה בריאיון — לא סומן «התראיין». אם הוא כן התראיין, סמנו ידנית בכרטיס.' });
  }
  db.prepare('UPDATE examinees SET in_interview = 0, interviewed = 1 WHERE code = ?').run(ex.code);
  const r = currentRunningRound();
  const slot = r ? getSlot(ex.code, r) : null;
  if (slot && slot.kind === 'chapter' && slot.paused) {
    const add = slot.paused_at ? Math.floor((now() - slot.paused_at) / 1000) : 0;
    db.prepare('UPDATE slots SET paused = 0, paused_at = NULL, paused_accum_sec = paused_accum_sec + ? WHERE code = ? AND round = ?').run(add, ex.code, r);
  }
  logEvent(ex.code, 'interview_return', '');
  res.json({ ok: true });
});

// פתיחת הגשה מחדש — מחזיר משבצת פרק שהוגשה למצב פעיל
app.post('/api/examiner/reopen-submit', authExaminer, (req, res) => {
  const _g = examineeOfActiveDay((req.body || {}).code);
  if (_g.err) return res.status(_g.err).json({ error: _g.msg });
  const ex = _g.ex;
  const r = currentRunningRound();
  const slot = r ? getSlot(ex.code, r) : null;
  if (!slot || slot.kind !== 'chapter') return res.status(400).json({ error: 'אין פרק להחזרה.' });
  db.prepare("UPDATE slots SET status = 'active' WHERE code = ? AND round = ?").run(ex.code, r);
  logEvent(ex.code, 'reopen_submit', '');
  res.json({ ok: true });
});

// סימון שנבחן עזב (פטור) / החזרה לפעילות
app.post('/api/examiner/set-left', authExaminer, (req, res) => {
  const { left } = req.body || {};
  const _sg = examineeOfActiveDay(req.body && req.body.code);
  if (_sg.err) return res.status(_sg.err).json({ error: _sg.msg });
  const code = _sg.ex.code;
  db.prepare('UPDATE examinees SET status = ? WHERE code = ?').run(left ? 'left' : 'active', code);
  logEvent(code, left ? 'mark_left' : 'unmark_left', '');
  res.json({ ok: true });
});

// ============================================================
//  מראיינים וחדרים (מראיין = חדר קבוע ליום)
// ============================================================
app.get('/api/examiner/interviewers', authExaminer, (req, res) => {
  const rows = db.prepare('SELECT * FROM interviewers WHERE day_id = ? ORDER BY id').all(activeDayId());
  const marks = db.prepare('SELECT round, code, interviewer_id FROM interview_marks').all();
  res.json({
    interviewers: rows.map((v) => ({
      id: v.id, name: v.name, room: v.room || '', brief: v.brief || '', active: !!v.active,
      load: marks.filter((m) => m.interviewer_id === v.id).length,
    })),
  });
});

app.post('/api/examiner/add-interviewer', authExaminer, (req, res) => {
  const b = req.body || {};
  const name = normName(b.name);
  if (!name) return res.status(400).json({ error: 'נדרש שם מראיין.' });
  const dayId = activeDayId();
  const dup = db.prepare('SELECT id FROM interviewers WHERE day_id = ? AND name = ?').get(dayId, name);
  if (dup) return res.status(409).json({ error: 'מראיין בשם הזה כבר קיים ביום הזה.' });
  const info = db.prepare('INSERT INTO interviewers (day_id, name, room, brief, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(dayId, name, String(b.room || '').trim(), String(b.brief || '').trim(), now());
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

// הוספת רשימה: שורה לכל מראיין — "שם, חדר"
app.post('/api/examiner/add-interviewers-bulk', authExaminer, (req, res) => {
  const lines = String((req.body && req.body.text) || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const dayId = activeDayId();
  let added = 0; const skipped = [];
  for (const line of lines) {
    const parts = line.split(/[,\t;]/).map((s) => s.trim());
    const name = normName(parts[0]); const room = parts[1] || '';
    if (!name) { skipped.push(line + ' (חסר שם)'); continue; }
    if (db.prepare('SELECT id FROM interviewers WHERE day_id = ? AND name = ?').get(dayId, name)) { skipped.push(name + ' (כבר קיים)'); continue; }
    db.prepare('INSERT INTO interviewers (day_id, name, room, brief, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(dayId, name, room, '', now());
    added++;
  }
  res.json({ ok: true, added, skipped });
});

app.post('/api/examiner/edit-interviewer', authExaminer, (req, res) => {
  const b = req.body || {};
  const id = Number(b.id);
  const v = db.prepare('SELECT * FROM interviewers WHERE id = ? AND day_id = ?').get(id, activeDayId());
  if (!v) return res.status(404).json({ error: 'מראיין לא נמצא.' });
  const name = b.name != null ? normName(b.name) : v.name;
  if (!name) return res.status(400).json({ error: 'נדרש שם.' });
  db.prepare('UPDATE interviewers SET name = ?, room = ?, brief = ?, active = ? WHERE id = ?').run(
    name,
    b.room != null ? String(b.room).trim() : (v.room || ''),
    b.brief != null ? String(b.brief).trim() : (v.brief || ''),
    b.active != null ? (b.active ? 1 : 0) : v.active,
    id
  );
  res.json({ ok: true });
});

app.post('/api/examiner/remove-interviewer', authExaminer, (req, res) => {
  const id = Number((req.body || {}).id);
  const used = db.prepare('SELECT COUNT(*) AS c FROM interview_marks WHERE interviewer_id = ?').get(id).c;
  if (used > 0) return res.status(400).json({ error: 'למראיין הזה יש ' + used + ' ריאיונות משובצים. יש להעביר אותם קודם (או להשתמש ב«הסר את כל המראיינים»).' });
  db.prepare('DELETE FROM interviewers WHERE id = ? AND day_id = ?').run(id, activeDayId());
  res.json({ ok: true });
});

// הסרת כל המראיינים של היום (איפוס) — מנקה גם את השיבוצים שלהם.
// סימוני הריאיון עצמם (מי בסבב) נשמרים, רק המראיין מתרוקן.
app.post('/api/examiner/remove-all-interviewers', authExaminer, (req, res) => {
  const dayId = activeDayId();
  makeBackup('pre-remove-all-interviewers');
  const n = db.prepare('SELECT COUNT(*) AS c FROM interviewers WHERE day_id = ?').get(dayId).c;
  db.prepare(`UPDATE interview_marks SET interviewer_id = NULL
              WHERE interviewer_id IN (SELECT id FROM interviewers WHERE day_id = ?)`).run(dayId);
  db.prepare('DELETE FROM interviewers WHERE day_id = ?').run(dayId);
  logEvent(null, 'remove_all_interviewers', String(n));
  res.json({ ok: true, removed: n });
});

// שיבוץ מראיין לריאיון של נבחן (בסבב מסוים). עובד גם בלייב.
app.post('/api/examiner/assign-interviewer', authExaminer, (req, res) => {
  const b = req.body || {};
  const _g = examineeOfActiveDay(b.code);
  if (_g.err) return res.status(_g.err).json({ error: _g.msg });
  const ex = _g.ex;
  const r = Number(b.round);
  if (!r || r < 1 || r > totalRounds()) return res.status(400).json({ error: 'מספר סבב לא תקין.' });
  const ivId = b.interviewer_id ? Number(b.interviewer_id) : null;
  if (ivId && !db.prepare('SELECT id FROM interviewers WHERE id = ? AND day_id = ?').get(ivId, activeDayId())) {
    return res.status(404).json({ error: 'מראיין לא נמצא.' });
  }
  // ⚠ סבב שהסתיים כבר לא ניתן לשיבוץ — הריאיון לא יתקיים והמראיין יחכה לחינם.
  const rState = roundState(r);
  if (rState === 'ended') {
    return res.status(400).json({ error: 'סבב ' + r + ' הסתיים — אי אפשר לשבץ אליו ריאיון. בחרו סבב שטרם התחיל.' });
  }
  // מראיין אחד = נבחן אחד בסבב. אחרת שני נבחנים נשלחים לאותו חדר באותו זמן.
  if (ivId) {
    const busy = interviewerBusy(ivId, r, ex.code);
    if (busy) {
      const iv = db.prepare('SELECT name, room FROM interviewers WHERE id = ?').get(ivId);
      return res.status(400).json({ error: (iv ? iv.name : 'המראיין') + ' כבר מראיין/ת את ' + busy + ' בסבב ' + r + '. בחרו מראיין אחר או סבב אחר.' });
    }
  }
  // מסמן ריאיון בסבב הזה (אם עוד לא מסומן) ומצמיד מראיין
  db.prepare('INSERT OR IGNORE INTO interview_marks (round, code) VALUES (?, ?)').run(r, ex.code);
  db.prepare('UPDATE interview_marks SET interviewer_id = ? WHERE round = ? AND code = ?').run(ivId, r, ex.code);

  // ⚠ תיקון עצמי כשהסבב *כבר רץ*: המשבצות נבנו ב-start-round, ולכן סימון
  // ריאיון עכשיו לא יצר משבצת — הנבחן היה נשאר בפרק, והמראיינת הייתה יושבת
  // וממתינה למישהי שלעולם לא תגיע. אותו דפוס כמו התיקון-העצמי ב-complete-setup.
  let switched = false;
  if (roundState(r) === 'running' && !hasInterviewed(ex.code)) {
    const slot = getSlot(ex.code, r);
    if (!slot) {
      db.prepare('INSERT INTO slots (code, round, kind, subject, level, chapter_id, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(code, round) DO NOTHING')
        .run(ex.code, r, 'interview', null, null, null, SLOT_DURATION_SEC);
      switched = true;
    } else if (slot.kind !== 'interview' && slot.status !== 'done') {
      // הנבחן עדיין לא הגיש את הפרק — מחליפים אותו לריאיון. התשובות נשמרות
      // (הן ממופתחות לפי פרק ולא לפי סבב) והפרק יחזור אליו בסבב הבא.
      db.prepare("UPDATE slots SET kind = 'interview', subject = NULL, level = NULL, chapter_id = NULL, started_at = NULL, paused = 0, paused_at = NULL, paused_accum_sec = 0 WHERE code = ? AND round = ?")
        .run(ex.code, r);
      switched = true;
    }
    if (switched) logEvent(ex.code, 'late_interview_slot', 'סבב ' + r + ' — שובץ לריאיון בזמן שהסבב רץ');
  }
  logEvent(ex.code, 'assign_interviewer', 'סבב ' + r + ' · מראיין ' + (ivId || '—'));
  res.json({ ok: true, switched_to_interview: switched });
});

// הזנת בריפים בכמות: שורה לכל נבחן, «שם <מפריד> בריף».
// מפצלים על *התו הראשון בלבד* (טאב → | → פסיק) כדי שפסיקים בתוך הבריף לא ישברו.
// התאמה מדויקת → משייך. התאמה מקורבת → *מציע בלבד*. לא נמצא → נשמר כממתין לשיוך.
app.post('/api/examiner/set-briefs-bulk', authExaminer, (req, res) => {
  const text = String((req.body && req.body.text) || '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const dayId = activeDayId();
  const all = db.prepare('SELECT code, name FROM examinees WHERE day_id = ?').all(dayId);

  let updated = 0;
  const suggested = [];    // שם מהדבקה + הצעות שיוך (לא שויך!)
  const unmatched = [];    // לא נמצאה שום התאמה — נשמר כממתין
  const skipped = [];
  const seen = {};         // לזיהוי כפילויות בתוך ההדבקה
  const duplicates = [];

  for (const line of lines) {
    let idx = -1;
    for (const sep of ['\t', '|', ',']) {
      const at = line.indexOf(sep);
      if (at > 0 && (idx === -1 || at < idx)) idx = at;
    }
    if (idx <= 0) { skipped.push(line.slice(0, 60) + ' (אין מפריד)'); continue; }
    const rawName = normName(line.slice(0, idx));
    const brief = line.slice(idx + 1).trim().slice(0, 2000);
    if (!rawName) { skipped.push(line.slice(0, 60) + ' (חסר שם)'); continue; }

    const m = nameMatch.matchName(rawName, all);
    if (m.exact) {
      const key = m.exact.code;
      if (seen[key]) duplicates.push(m.exact.name);   // אותו נבחן פעמיים — האחרון קובע
      seen[key] = true;
      db.prepare('UPDATE examinees SET interview_brief = ? WHERE code = ?').run(brief, m.exact.code);
      updated++;
      continue;
    }
    // לא מדויק — שומרים כממתין (עם ההצעות שיוצגו במסך הבקרה)
    const info = db.prepare('INSERT INTO pending_briefs (day_id, raw_name, brief, created_at) VALUES (?, ?, ?, ?)')
      .run(dayId, rawName, brief, now());
    const rec = { pending_id: Number(info.lastInsertRowid), raw_name: rawName, brief: brief, suggestions: m.suggestions };
    if (m.suggestions.length) suggested.push(rec); else unmatched.push(rec);
  }
  logEvent(null, 'set_briefs_bulk', updated + ' שויכו · ' + suggested.length + ' להצעה · ' + unmatched.length + ' ללא התאמה');
  res.json({ ok: true, updated, suggested, unmatched, duplicates, skipped });
});

// תמונת מצב מלאה של הבריפים — מי יש, מי אין, ומה ממתין לשיוך
app.get('/api/examiner/briefs-status', authExaminer, (req, res) => {
  const dayId = activeDayId();
  const all = db.prepare('SELECT code, name, interview_brief, status FROM examinees WHERE day_id = ? ORDER BY name').all(dayId);
  const examinees = all.map((e) => ({
    code: e.code, name: e.name,
    brief: e.interview_brief || '',
    has_brief: !!String(e.interview_brief || '').trim(),
    left: e.status === 'left',
  }));
  // כפילויות שם בתוך היום (מקור אמיתי לבלבול בשיוך)
  const nameCount = {};
  all.forEach((e) => { const k = normName(e.name); nameCount[k] = (nameCount[k] || 0) + 1; });
  const dupNames = Object.keys(nameCount).filter((k) => nameCount[k] > 1);

  const pendingRows = db.prepare('SELECT * FROM pending_briefs WHERE day_id = ? ORDER BY id').all(dayId);
  const pending = pendingRows.map((p) => ({
    pending_id: p.id, raw_name: p.raw_name, brief: p.brief || '',
    suggestions: nameMatch.matchName(p.raw_name, all.map((e) => ({ code: e.code, name: e.name }))).suggestions,
  }));

  res.json({
    examinees,
    with_brief: examinees.filter((e) => e.has_brief).length,
    without_brief: examinees.filter((e) => !e.has_brief && !e.left).length,
    pending: pending,
    duplicate_names: dupNames,
  });
});

// שיוך מהיר של בריף ממתין לנבחן שנבחר
app.post('/api/examiner/assign-pending-brief', authExaminer, (req, res) => {
  const b = req.body || {};
  const p = db.prepare('SELECT * FROM pending_briefs WHERE id = ? AND day_id = ?').get(Number(b.pending_id), activeDayId());
  if (!p) return res.status(404).json({ error: 'הבריף הממתין לא נמצא.' });
  const ex = getExamineeByCode.get(b.code);
  if (!ex || ex.day_id !== activeDayId()) return res.status(404).json({ error: 'נבחן לא נמצא ביום הזה.' });
  db.prepare('UPDATE examinees SET interview_brief = ? WHERE code = ?').run(String(p.brief || '').slice(0, 2000), ex.code);
  db.prepare('DELETE FROM pending_briefs WHERE id = ?').run(p.id);
  logEvent(ex.code, 'assign_brief', p.raw_name + ' → ' + ex.name);
  res.json({ ok: true, name: ex.name });
});

app.post('/api/examiner/delete-pending-brief', authExaminer, (req, res) => {
  db.prepare('DELETE FROM pending_briefs WHERE id = ? AND day_id = ?').run(Number((req.body || {}).pending_id), activeDayId());
  res.json({ ok: true });
});

app.post('/api/examiner/clear-brief', authExaminer, (req, res) => {
  const _g = examineeOfActiveDay((req.body || {}).code);
  if (_g.err) return res.status(_g.err).json({ error: _g.msg });
  const ex = _g.ex;
  db.prepare("UPDATE examinees SET interview_brief = '' WHERE code = ?").run(ex.code);
  res.json({ ok: true });
});

// בריף קצר על נבחן — מה שהמראיין שלו יראה
app.post('/api/examiner/set-examinee-brief', authExaminer, (req, res) => {
  const b = req.body || {};
  const _g = examineeOfActiveDay(b.code);
  if (_g.err) return res.status(_g.err).json({ error: _g.msg });
  const ex = _g.ex;
  db.prepare('UPDATE examinees SET interview_brief = ? WHERE code = ?').run(String(b.brief || '').slice(0, 2000), ex.code);
  res.json({ ok: true });
});

// חלוקה אוטומטית לקבוצות: מפזר את מי שעדיין לא משובץ לריאיון על פני הסבבים הפתוחים, שווה בשווה
app.post('/api/examiner/autosplit-interviews', authExaminer, (req, res) => {
  const plannedRounds = db.prepare("SELECT round FROM day_rounds WHERE day_id = ? AND state = 'planned' ORDER BY round").all(activeDayId()).map((r) => r.round);
  if (!plannedRounds.length) return res.status(400).json({ error: 'אין סבבים פתוחים לתכנון.' });
  const marked = new Set(db.prepare("SELECT code FROM interview_marks WHERE round IN (SELECT round FROM day_rounds WHERE day_id = ? AND state = 'planned')").all(activeDayId()).map((r) => r.code));
  // כולל נבחנים במצב 'registered' — בשלב ההרשמה של הבוקר הם עדיין לא 'active',
  // והמנהל צריך לשבץ להם ריאיונות בזמן הזה בדיוק.
  const rows = db.prepare("SELECT code FROM examinees WHERE status != 'left' AND interviewed = 0 AND day_id = ? ORDER BY created_at").all(activeDayId()).filter((r) => !marked.has(r.code));

  // משבצים גם סבב וגם מראיין, בלי חפיפות: מראיין אחד = נבחן אחד בסבב.
  // בונים לוח תפוסה (סבב → אילו מראיינים תפוסים) מהשיבוצים הקיימים.
  const ivs = db.prepare('SELECT id FROM interviewers WHERE day_id = ? AND active = 1 ORDER BY id').all(activeDayId()).map((v) => v.id);
  if (!ivs.length) {
    return res.status(400).json({ error: 'אין מראיינים ביום הזה. הוסיפו מראיינים (שם + חדר) לפני החלוקה האוטומטית.' });
  }
  const taken = {};   // round -> Set(interviewer_id)
  const load = {};    // interviewer_id -> כמה ריאיונות כבר יש לו (לחלוקה מאוזנת)
  ivs.forEach((id) => { load[id] = 0; });
  plannedRounds.forEach((rd) => { taken[rd] = new Set(); });
  db.prepare(`SELECT m.round, m.interviewer_id FROM interview_marks m JOIN examinees e ON e.code = m.code
              WHERE e.day_id = ? AND m.interviewer_id IS NOT NULL`).all(activeDayId())
    .forEach((m) => {
      if (taken[m.round]) taken[m.round].add(m.interviewer_id);
      load[m.interviewer_id] = (load[m.interviewer_id] || 0) + 1;
    });

  let assigned = 0, withInterviewer = 0;
  const unassigned = [];
  for (const ex of rows) {
    // בוחרים את הסבב שבו יש הכי הרבה מראיינים פנויים (מאזן וגם ממקסם שיבוץ)
    let bestRound = null, bestFree = -1;
    for (const rd of plannedRounds) {
      const free = ivs.filter((id) => !taken[rd].has(id)).length;
      if (free > bestFree) { bestFree = free; bestRound = rd; }
    }
    // אם אין מראיין פנוי באף סבב — מפזרים round-robin במקום לדחוס הכול לסבב הראשון
    if (bestFree <= 0) bestRound = plannedRounds[assigned % plannedRounds.length];
    if (bestRound == null) break;
    db.prepare('INSERT OR IGNORE INTO interview_marks (round, code) VALUES (?, ?)').run(bestRound, ex.code);
    assigned++;
    // מבין הפנויים בסבב — בוחרים את זה שיש לו הכי מעט ריאיונות, כדי לחלק בהוגנות
    // (אחרת המראיין הראשון היה מקבל את כולם והשאר אפס).
    const freeIv = ivs
      .filter((id) => !taken[bestRound].has(id))
      .sort((a, b) => (load[a] || 0) - (load[b] || 0))[0];
    if (freeIv) {
      db.prepare('UPDATE interview_marks SET interviewer_id = ? WHERE round = ? AND code = ?').run(freeIv, bestRound, ex.code);
      taken[bestRound].add(freeIv);
      load[freeIv] = (load[freeIv] || 0) + 1;
      withInterviewer++;
    } else {
      unassigned.push(ex.code);   // אין מראיין פנוי — שובץ לסבב בלי מראיין
    }
  }
  const capacity = ivs.length * plannedRounds.length;
  logEvent(null, 'autosplit', `${assigned} לסבבים · ${withInterviewer} עם מראיין`);
  res.json({
    ok: true, assigned, with_interviewer: withInterviewer,
    without_interviewer: unassigned.length,
    capacity,
    note: unassigned.length
      ? unassigned.length + ' נבחנים שובצו לסבב אבל בלי מראיין — אין מספיק מראיינים (קיבולת: ' + capacity + ').'
      : null,
  });
});

// סטטוס חי של כל הנבחנים + מצב הסבבים + סימוני ריאיון
app.get('/api/examiner/status', authExaminer, (req, res) => {
  const running = currentRunningRound();
  const roundsArr = db.prepare('SELECT round, state, started_at FROM day_rounds WHERE day_id = ? ORDER BY round').all(activeDayId());
  const marks = db.prepare('SELECT round, code, interviewer_id FROM interview_marks').all();
  const ivById = {};
  db.prepare('SELECT * FROM interviewers WHERE day_id = ?').all(activeDayId()).forEach((v) => { ivById[v.id] = v; });
  const examinees = db.prepare('SELECT * FROM examinees WHERE day_id = ? ORDER BY created_at').all(activeDayId());
  const list = examinees.map((ex) => {
    const subjects = JSON.parse(ex.subjects || '[]');
    const setup = subjects.length > 0;
    const chapterList = setup ? chapterListForEx(ex) : [];
    const interviewed = hasInterviewed(ex.code);
    const slot = running ? getSlot(ex.code, running) : null;
    const timer = slot ? computeTimer(slot) : { state: 'none', remaining_sec: 0 };
    const answered = slot && slot.chapter_id
      ? db.prepare('SELECT COUNT(*) AS c FROM answers WHERE code = ? AND chapter_id = ?').get(ex.code, slot.chapter_id).c : 0;
    const flags = db.prepare("SELECT COUNT(*) AS c FROM events WHERE code = ? AND type IN ('blur','tabhide','paste_blocked')").get(ex.code).c;
    // ספירת פרקים שהושלמו לפי מקצוע — עקבי עם מנוע השיבוץ (עמיד לחזרות ולהחלפות)
    const doneCnt = {}; let doneTotal = 0;
    db.prepare("SELECT subject FROM slots WHERE code = ? AND kind = 'chapter' AND status = 'done'").all(ex.code)
      .forEach((r) => { doneCnt[r.subject] = (doneCnt[r.subject] || 0) + 1; doneTotal++; });
    const seenS = {}; const doneNames = []; const remaining = [];
    for (const c of chapterList) {
      const k = seenS[c.subject] || 0; seenS[c.subject] = k + 1;
      if (k < (doneCnt[c.subject] || 0)) doneNames.push(c.subject);
      else remaining.push(c.subject);
    }
    if (slot && slot.kind === 'chapter') { const i = remaining.indexOf(slot.subject); if (i >= 0) remaining.splice(i, 1); }
    const current = slot ? {
      round: slot.round, kind: slot.kind, subject: slot.subject, level: slot.level,
      status: slot.status, not_comfortable: !!slot.not_comfortable,
    } : null;
    const left = ex.status === 'left';
    const finished = setup && interviewed && chapterList.length > 0 && doneTotal >= chapterList.length;
    return {
      code: ex.code, name: ex.name, pin: ex.pin || '', setup, subjects, left,
      declaration: JSON.parse(ex.declaration || 'null'),
      chapters_total: chapterList.length,
      chapters_done: doneNames,
      remaining_chapters: remaining,
      interviewed, in_interview: !!ex.in_interview,
      needs_interview: setup && !interviewed && !finished && !left, finished,
      current, timer, answered, flags,
      marked_rounds: marks.filter((m) => m.code === ex.code).map((m) => m.round),
      // ריאיון: מי מראיין ובאיזה חדר (מראיין = חדר קבוע)
      interview_assign: marks.filter((m) => m.code === ex.code).map((m) => ({
        round: m.round,
        interviewer_id: m.interviewer_id || null,
        interviewer: m.interviewer_id && ivById[m.interviewer_id] ? ivById[m.interviewer_id].name : null,
        room: m.interviewer_id && ivById[m.interviewer_id] ? ivById[m.interviewer_id].room : null,
      })),
      interview_brief: ex.interview_brief || '',
      self_registered: !!ex.self_registered,
    };
  });
  // פס מוכנות: תנאי הבסיס והשיבוץ — כדי שיהיה ברור מה חסר לפני שמתחילים
  const relevant = list.filter((e) => !e.left);
  const withRound = relevant.filter((e) => e.interviewed || e.marked_rounds.length > 0);
  const withInterviewer = relevant.filter((e) => e.interviewed || e.interview_assign.some((a) => a.interviewer_id));
  const ivList = db.prepare('SELECT * FROM interviewers WHERE day_id = ? ORDER BY id').all(activeDayId());
  // קיבולת: מראיין אחד = נבחן אחד בסבב → צריך מראיינים ≥ ⌈נבחנים ÷ סבבים⌉
  const activeIvCount = ivList.filter((v) => v.active).length;
  const capacity = activeIvCount * totalRounds();
  const neededIv = totalRounds() > 0 ? Math.ceil(relevant.length / totalRounds()) : 0;
  // חפיפות: אותו מראיין לשני נבחנים באותו סבב
  const dupRows = db.prepare(`SELECT m.round, m.interviewer_id, COUNT(*) AS c
                              FROM interview_marks m JOIN examinees e ON e.code = m.code
                              WHERE e.day_id = ? AND m.interviewer_id IS NOT NULL
                              GROUP BY m.round, m.interviewer_id HAVING c > 1`).all(activeDayId());
  const doubleBooked = dupRows.map((d) => {
    const iv = ivById[d.interviewer_id];
    return (iv ? iv.name : 'מראיין ' + d.interviewer_id) + ' — סבב ' + d.round + ' (' + d.c + ' נבחנים)';
  });

  const readiness = {
    total: relevant.length,
    interview_assigned: withRound.length,
    interviewer_assigned: withInterviewer.length,
    all_have_interview: relevant.length > 0 && withRound.length === relevant.length,
    all_have_interviewer: relevant.length > 0 && withInterviewer.length === relevant.length,
    missing_interview: relevant.filter((e) => !e.interviewed && !e.marked_rounds.length).map((e) => e.name),
    missing_interviewer: relevant.filter((e) => !e.interviewed && !e.interview_assign.some((a) => a.interviewer_id)).map((e) => e.name),
    interviewers_without_room: ivList.filter((v) => !String(v.room || '').trim()).map((v) => v.name),
    self_registered: list.filter((e) => e.self_registered).map((e) => e.name),
    no_subjects: relevant.filter((e) => !e.setup).map((e) => e.name),
    rounds_ok: totalRounds() >= MIN_ROUNDS,
    // קיבולת מראיינים
    interviewers: activeIvCount,
    capacity: capacity,
    needed_interviewers: neededIv,
    capacity_ok: relevant.length === 0 || capacity >= relevant.length,
    double_booked: doubleBooked,
  };
  const d = activeDay();
  res.json({
    running, total_rounds: totalRounds(), rounds: roundsArr, examinees: list,
    // שעון הסבב + שעון השרת — בלי `server_now` הלקוח לא יכול לתקן סחף שעון.
    round_timer: computeRoundTimer(activeDayId(), running),
    server_now: now(),
    day: d ? {
      id: d.id, name: d.name, title: d.title, total_rounds: d.total_rounds, phase: d.phase,
      // נדרשים למסך: אינדיקציית «המבחן הסתיים»/«יום סגור» ותצוגת הודעת הסיום
      status: d.status, exam_ended: !!d.exam_ended, finish_message: d.finish_message || '',
    } : null,
    subject_count: chosenSubjectCount(),
    interviewers: ivList.map((v) => ({
      id: v.id, name: v.name, room: v.room || '', active: !!v.active,
      load: marks.filter((m) => m.interviewer_id === v.id).length,
    })),
    readiness,
    pending_swaps: db.prepare("SELECT COUNT(*) AS c FROM interview_swap_requests WHERE day_id = ? AND status = 'pending'").get(activeDayId()).c,
  });
});

// מטריצה מלאה: לכל נבחן שורת 5 תאים (סבב 1..5). עבר/הווה = אמת (מ-slots), עתיד = צפי.
app.get('/api/examiner/matrix', authExaminer, (req, res) => {
  const running = currentRunningRound();
  const roundsArr = db.prepare('SELECT round, state FROM day_rounds WHERE day_id = ? ORDER BY round').all(activeDayId());
  const examinees = db.prepare('SELECT * FROM examinees WHERE day_id = ? ORDER BY created_at').all(activeDayId());
  const N = totalRounds();

  const list = examinees.map((ex) => {
    const setup = JSON.parse(ex.subjects || '[]').length > 0;
    const chapterList = setup ? chapterListForEx(ex) : [];
    const left = ex.status === 'left';
    const cells = new Array(N + 1).fill(null); // אינדקס 1..5

    // מה כבר שובץ בפועל (בסבבים שהתחילו) — לחישוב הצפי לעתיד. ספירה לפי מקצוע (עקבי עם "החלף שאלה" ועם חזרות).
    const servedCnt = {};
    db.prepare("SELECT subject FROM slots WHERE code = ? AND kind = 'chapter'").all(ex.code)
      .forEach((r) => { servedCnt[r.subject] = (servedCnt[r.subject] || 0) + 1; });
    const hadInterviewSlot = !!db.prepare("SELECT 1 FROM slots WHERE code = ? AND kind = 'interview'").get(ex.code);
    let interviewedProjected = hasInterviewed(ex.code) || hadInterviewSlot;

    // שלב א' — סבבים שהתחילו (running/ended): קוראים את המשבצת האמיתית.
    for (let r = 1; r <= N; r++) {
      const rState = (roundsArr.find((x) => x.round === r) || {}).state || 'planned';
      if (rState === 'planned') continue; // עתיד — נטופל בשלב ב'
      const slot = getSlot(ex.code, r);
      if (!slot) { cells[r] = { type: 'idle', label: '—' }; continue; }
      if (slot.kind === 'interview') {
        cells[r] = { type: r === running ? 'interview_current' : 'interview_done', label: 'ריאיון' };
      } else {
        const done = slot.status === 'done';
        cells[r] = { type: done ? 'done' : 'current', label: slot.subject || '—', level: slot.level || null };
      }
    }

    // שלב ב' — סבבים עתידיים (planned): צפי מלא לפי המקצועות שנותרו (ייחודי) + סימוני ריאיון.
    const seenC = {};
    const remaining = chapterList.filter((c) => { const k = seenC[c.subject] || 0; seenC[c.subject] = k + 1; return k >= (servedCnt[c.subject] || 0); });
    let pi = 0;
    for (let r = 1; r <= N; r++) {
      const rState = (roundsArr.find((x) => x.round === r) || {}).state || 'planned';
      if (rState !== 'planned') continue;
      if (isMarkedInterview(r, ex.code) && !interviewedProjected) {
        cells[r] = { type: 'interview_future', label: 'ריאיון' };
        interviewedProjected = true;
      } else if (pi < remaining.length) {
        const c = remaining[pi++];
        cells[r] = { type: 'predicted', label: c.subject, level: c.level || null };
      } else if (!interviewedProjected) {
        cells[r] = { type: 'interview_future', label: 'ריאיון' };
        interviewedProjected = true;
      } else {
        cells[r] = { type: 'idle', label: '—' };
      }
    }

    return {
      code: ex.code, name: ex.name, left, setup,
      needs_interview_unplanned: setup && !interviewedProjected && !left,
      cells: cells.slice(1), // 0-based מערך של 5
    };
  });

  res.json({ running, total_rounds: N, rounds: roundsArr, examinees: list });
});

// עקיפות ידניות: הוספת זמן / השהיה / המשך / איפוס משבצת
app.post('/api/examiner/override', authExaminer, (req, res) => {
  const { round, action, seconds } = req.body || {};
  const _og = examineeOfActiveDay(req.body && req.body.code);
  if (_og.err) return res.status(_og.err).json({ error: _og.msg });
  const code = _og.ex.code;
  const r = Number(round) || currentRunningRound();
  const slot = r ? getSlot(code, r) : null;
  if (!slot) return res.status(404).json({ error: 'לא נמצאה משבצת.' });
  const t = now();
  switch (action) {
    case 'add_time': {
      // חסימה: שניות שליליות/ענקיות הרסו את הטיימר לחלוטין
      let add = Math.round(Number(seconds));
      if (!isFinite(add) || add === 0) add = 60;
      add = Math.max(-3600, Math.min(3600, add));
      db.prepare('UPDATE slots SET duration_sec = MAX(60, duration_sec + ?) WHERE code = ? AND round = ?')
        .run(add, code, r);
      break;
    }
    case 'pause':
      if (!slot.paused) db.prepare('UPDATE slots SET paused = 1, paused_at = ? WHERE code = ? AND round = ?').run(t, code, r);
      break;
    case 'resume':
      if (slot.paused) {
        const add = slot.paused_at ? Math.floor((t - slot.paused_at) / 1000) : 0;
        db.prepare('UPDATE slots SET paused = 0, paused_at = NULL, paused_accum_sec = paused_accum_sec + ? WHERE code = ? AND round = ?')
          .run(add, code, r);
      }
      break;
    case 'reset_slot':
      db.prepare('UPDATE slots SET started_at = NULL, status = ?, paused = 0, paused_at = NULL, paused_accum_sec = 0 WHERE code = ? AND round = ?')
        .run('pending', code, r);
      break;
    case 'start':
      db.prepare('UPDATE slots SET started_at = ?, status = ? WHERE code = ? AND round = ?').run(t, 'active', code, r);
      break;
    case 'finish': // סיום מוקדם של המשבצת (לפני הטיימר) — הנבחן עובר להמתנה
      db.prepare('UPDATE slots SET status = ? WHERE code = ? AND round = ?').run('done', code, r);
      break;
    default:
      return res.status(400).json({ error: 'פעולה לא מוכרת.' });
  }
  logEvent(code, 'override', `${action} round ${r}`);
  res.json({ ok: true });
});

// ---------- בקשות החלפה מהמראיינים (המנהל מאשר) ----------
app.get('/api/examiner/swap-requests', authExaminer, (req, res) => {
  const rows = db.prepare(`SELECT s.*, i.name AS interviewer_name, i.room AS room, e.name AS examinee_name
                           FROM interview_swap_requests s
                           LEFT JOIN interviewers i ON i.id = s.interviewer_id
                           LEFT JOIN examinees e ON e.code = s.code
                           WHERE s.day_id = ? ORDER BY (s.status = 'pending') DESC, s.id DESC LIMIT 50`).all(activeDayId());
  res.json({ requests: rows });
});

// אישור/דחייה. באישור אפשר לבצע את השינוי בפועל (סבב/מראיין חדשים).
app.post('/api/examiner/decide-swap', authExaminer, (req, res) => {
  const b = req.body || {};
  const reqRow = db.prepare('SELECT * FROM interview_swap_requests WHERE id = ? AND day_id = ?').get(Number(b.id), activeDayId());
  if (!reqRow) return res.status(404).json({ error: 'בקשה לא נמצאה.' });
  if (reqRow.status !== 'pending') return res.status(400).json({ error: 'הבקשה כבר טופלה.' });

  if (b.approve) {
    // אם המנהל ציין סבב/מראיין חדשים — מבצעים בפועל
    const newRound = b.new_round ? Number(b.new_round) : null;
    const newIv = b.new_interviewer_id !== undefined ? (b.new_interviewer_id ? Number(b.new_interviewer_id) : null) : undefined;
    if (reqRow.code && (newRound || newIv !== undefined)) {
      const targetRound = newRound || reqRow.round;
      if (targetRound && newRound && newRound !== reqRow.round) {
        if (roundState(newRound) !== 'planned') return res.status(400).json({ error: 'הסבב החדש כבר התחיל.' });
        db.prepare('DELETE FROM interview_marks WHERE code = ? AND round = ?').run(reqRow.code, reqRow.round);
        db.prepare('INSERT OR IGNORE INTO interview_marks (round, code) VALUES (?, ?)').run(newRound, reqRow.code);
      }
      if (newIv !== undefined && targetRound) {
        // ⚠ אותה אכיפה כמו ב-assign-interviewer. בלעדיה מסלול «בקשת החלפה»
        // עקף את «מראיין אחד = נבחן אחד בסבב» ושלח שני נבחנים לאותו חדר.
        if (newIv) {
          const iv = db.prepare('SELECT * FROM interviewers WHERE id = ? AND day_id = ?').get(newIv, activeDayId());
          if (!iv) return res.status(404).json({ error: 'המראיין/ת אינו קיים ביום הזה.' });
          const busy = interviewerBusy(newIv, targetRound, reqRow.code);
          if (busy) return res.status(400).json({ error: iv.name + ' כבר מראיין/ת את ' + busy + ' בסבב ' + targetRound + '. בחרו מראיין אחר או סבב אחר.' });
        }
        db.prepare('UPDATE interview_marks SET interviewer_id = ? WHERE round = ? AND code = ?').run(newIv, targetRound, reqRow.code);
      }
    }
  }
  db.prepare('UPDATE interview_swap_requests SET status = ?, decided_at = ? WHERE id = ?')
    .run(b.approve ? 'approved' : 'rejected', now(), reqRow.id);
  res.json({ ok: true });
});

// ---------- תיקון פרק בלייב (רמה / נושא / מקצוע) בלי לאפס את הזמן ----------
// לפעמים נבחן נכנס לפרק ברמה לא נכונה. הפעולות כאן מחליפות את תוכן המשבצת
// ומשאירות את started_at/paused כמו שהם — כלומר הנבחן ממשיך עם הזמן שנשאר.
app.post('/api/examiner/fix-slot', authExaminer, (req, res) => {
  const b = req.body || {};
  const code = b.code;
  const r = Number(b.round) || currentRunningRound();
  const _g = examineeOfActiveDay(code);
  if (_g.err) return res.status(_g.err).json({ error: _g.msg });
  const ex = _g.ex;
  const slot = getSlot(code, r);
  if (!slot || slot.kind !== 'chapter') return res.status(400).json({ error: 'אין פרק פעיל לנבחן בסבב זה.' });

  let next = null, newSubject = slot.subject, newLevel = slot.level;

  if (b.action === 'lower_level') {
    if (slot.subject !== 'מתמטיקה') return res.status(400).json({ error: 'הורדת רמה רלוונטית למתמטיקה בלבד.' });
    const lower = schedule.lowerLevel(slot.level || '5');
    if (String(lower) === String(slot.level)) return res.status(400).json({ error: 'הנבחן/ת כבר ברמה הנמוכה ביותר (3 יח״ל).' });
    const served = servedChapterIds(code, r);
    const pool = (content.bySubject.get('מתמטיקה') || []).filter((c) => String(c.level) === String(lower));
    next = pool.find((c) => !served.has(c.chapter_id)) || pool[0] || null;
    if (!next) return res.status(400).json({ error: 'אין פרק מתמטיקה זמין ברמה ' + lower + '.' });
    newLevel = String(lower);
    // מעדכנים גם את רמת המתמטיקה של הנבחן, כדי שהפרקים הבאים יהיו באותה רמה
    db.prepare('UPDATE examinees SET math_level = ? WHERE code = ?').run(String(lower), code);
  } else if (b.action === 'swap_variant') {
    next = pickSwapChapter(code, slot, r);
    if (!next) return res.status(400).json({ error: 'אין נושא חלופי זמין במקצוע הזה.' });
  } else if (b.action === 'change_subject') {
    const subject = String(b.subject || '').trim();
    if (!subject) return res.status(400).json({ error: 'חסר מקצוע.' });
    const served = servedChapterIds(code, r);
    const level = subject === 'מתמטיקה' ? (b.level || ex.math_level || '5') : null;
    const pool = (content.bySubject.get(subject) || []).filter((c) =>
      subject !== 'מתמטיקה' || !level || String(c.level) === String(level));
    next = pool.find((c) => !served.has(c.chapter_id)) || pool[0] || null;
    if (!next) return res.status(400).json({ error: 'אין פרק זמין במקצוע ' + subject + '.' });
    newSubject = subject; newLevel = next.level || null;
  } else {
    return res.status(400).json({ error: 'פעולה לא מוכרת.' });
  }

  // ⚠ במפורש לא נוגעים ב-started_at / paused / paused_accum_sec — הזמן ממשיך.
  db.prepare('UPDATE slots SET subject = ?, level = ?, chapter_id = ?, variant_index = 0 WHERE code = ? AND round = ?')
    .run(newSubject, newLevel, next.chapter_id, code, r);
  logEvent(code, 'fix_slot', b.action + ' → ' + next.chapter_id + ' (סבב ' + r + ')');
  res.json({ ok: true, subject: newSubject, level: newLevel, chapter_id: next.chapter_id });
});

// השהיה/המשך של כל הנבחנים בסבב הנוכחי בבת אחת
app.post('/api/examiner/pause-all', authExaminer, (req, res) => {
  const pause = req.body && req.body.pause !== false; // ברירת מחדל: השהה
  const r = currentRunningRound();
  const t = now();
  // ⚠ גם משבצות שעדיין `pending` — נבחן שטרם פתח את הפרק (מאחר, מתחבר מחדש).
  // בעבר נשלפו רק `active`, ולכן «השהה את כולם» דילג עליו, וכשהיה פותח את
  // הפרק `ensureSlotStarted` היה מתחיל לו טיימר במלוא המהירות בזמן השהיה כללית.
  const slots = db.prepare("SELECT * FROM slots WHERE round = ? AND kind = 'chapter' AND status IN ('pending','active')" + DAY_SCOPE).all(r, activeDayId());
  // ⚠ מי שנמצא *עכשיו* בחדר הריאיון מושהה ע"י interview-out, ו-interview-return
  // הוא זה שיפצה אותו. «המשך לכולם» לא אמור לשחרר אותו — אחרת הוא מאבד את
  // הזמן שבו הוא לא היה מול המסך, ו-interview-return כבר לא רואה `paused`.
  const inInterview = new Set(db.prepare('SELECT code FROM examinees WHERE day_id = ? AND in_interview = 1').all(activeDayId()).map((x) => x.code));
  let n = 0, skipped = 0;
  for (const s of slots) {
    if (pause && !s.paused) {
      db.prepare('UPDATE slots SET paused = 1, paused_at = ? WHERE code = ? AND round = ?').run(t, s.code, r);
      n++;
    } else if (!pause && s.paused) {
      if (inInterview.has(s.code)) { skipped++; continue; }
      const add = s.paused_at ? Math.floor((t - s.paused_at) / 1000) : 0;
      db.prepare('UPDATE slots SET paused = 0, paused_at = NULL, paused_accum_sec = paused_accum_sec + ? WHERE code = ? AND round = ?').run(add, s.code, r);
      n++;
    }
  }
  // ⚠ גם שעון הסבב עצמו — אחרת בהשהיה כללית הספירה שהמנהל והנבחנים רואים
  // ממשיכה לרוץ ומשקרת. מתבצע תמיד, גם אם 0 משבצות הושפעו.
  const dr = db.prepare('SELECT paused, paused_at FROM day_rounds WHERE day_id = ? AND round = ?').get(activeDayId(), r);
  if (dr) {
    if (pause && !dr.paused) {
      db.prepare('UPDATE day_rounds SET paused = 1, paused_at = ? WHERE day_id = ? AND round = ?').run(t, activeDayId(), r);
    } else if (!pause && dr.paused) {
      const add = dr.paused_at ? Math.floor((t - dr.paused_at) / 1000) : 0;
      db.prepare('UPDATE day_rounds SET paused = 0, paused_at = NULL, paused_accum_sec = paused_accum_sec + ? WHERE day_id = ? AND round = ?')
        .run(add, activeDayId(), r);
    }
  }
  logEvent(null, pause ? 'pause_all' : 'resume_all', `round ${r} · ${n} נבחנים` + (skipped ? ` · ${skipped} בריאיון (דולגו)` : ''));
  res.json({ ok: true, affected: n, paused: pause, skipped_in_interview: skipped });
});

// סיום המבחן כולו (לפני הזמן) — כל הנבחנים עוברים למסך "המבחן הסתיים"
app.post('/api/examiner/end-exam', authExaminer, (req, res) => {
  const ended = !(req.body && req.body.ended === false);
  setExamEnded(ended);
  logEvent(null, ended ? 'end_exam' : 'reopen_exam', '');
  res.json({ ok: true, ended });
});

// מצב המבחן (האם הסתיים)
app.get('/api/examiner/exam-state', authExaminer, (req, res) => {
  res.json({ ended: examEnded(), finish_message: finishMessage() });
});

// בונה מבנה ייצוא מלא (משמש גם לייצוא ידני וגם לגיבוי אוטומטי)
function buildFullExport(dayId) {
  const examinees = db.prepare('SELECT * FROM examinees WHERE day_id = ? ORDER BY created_at').all(dayId || activeDayId());
  const out = examinees.map((ex) => {
    const slots = db.prepare('SELECT * FROM slots WHERE code = ? ORDER BY round').all(ex.code);
    const answers = db.prepare('SELECT * FROM answers WHERE code = ? ORDER BY round, item_id').all(ex.code);
    return {
      examinee: ex.name,
      code: ex.code,
      code_ref: codeRef(ex.code),
      subjects: JSON.parse(ex.subjects || '[]'),
      math_level: ex.math_level,
      interview_round: ex.interview_round,
      declaration: JSON.parse(ex.declaration || 'null'),
      slots: slots.map((s) => ({ round: s.round, kind: s.kind, subject: s.subject, level: s.level, chapter_id: s.chapter_id })),
      answers: answers.map((a) => ({
        round: a.round, chapter_id: a.chapter_id, item_id: a.item_id, type: a.type, answer: a.answer,
        dont_know: !!a.dont_know,
        started_at: a.started_at ? new Date(a.started_at).toISOString() : null,
        updated_at: a.updated_at ? new Date(a.updated_at).toISOString() : null,
        time_spent_sec: a.time_spent_sec,
      })),
    };
  });
  return { exported_at: new Date().toISOString(), examinees: out };
}

// ---------- מנגנון גיבוי אוטומטי (פועל גם בשרת, לדיסק הקבוע) ----------
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
const BACKUP_INTERVAL_MIN = Number(process.env.BACKUP_INTERVAL_MIN || 5);

function ensureBackupDir() { if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true }); }

function pruneBackups(prefix, keep) {
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith(prefix)).sort();
  while (files.length > keep) { const f = files.shift(); try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (e) {} }
}

function makeBackup(reason) {
  try {
    ensureBackupDir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    // (1) גיבוי לוגי קריא (JSON) — עקבי תמיד
    // גיבוי JSON של *כל* הימים — לא רק הפעיל (אחרת גיבוי של יום קודם חסר)
    const allDays = db.prepare('SELECT id, name FROM days ORDER BY id').all();
    const bundle = allDays.length
      ? allDays.map((d) => ({ day_id: d.id, day_name: d.name, examinees: buildFullExport(d.id) }))
      : buildFullExport();
    fs.writeFileSync(path.join(BACKUP_DIR, `backup-${ts}.json`), JSON.stringify(bundle));
    // (2) עותק פיזי של קובץ ה-DB (לשחזור מהיר) — אחרי איחוד ה-WAL
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, `snapshot-${ts}.db`)); } catch (e) {}
    pruneBackups('backup-', 72);   // ~6 שעות בקצב של 5 דק'
    pruneBackups('snapshot-', 24);
    return { ok: true, ts, reason: reason || 'auto' };
  } catch (e) {
    console.error('גיבוי נכשל:', e.message);
    return { ok: false, error: e.message };
  }
}

// הורדת כל התשובות כקובץ JSON (רשת ביטחון + מקור לבדיקת AI)
app.get('/api/examiner/export-all', authExaminer, (req, res) => {
  const jd = db.prepare('SELECT name FROM days WHERE id = ?').get(Number(req.query && req.query.day_id) || activeDayId());
  const jsonName = jd ? ('answers-' + jd.name + '.json') : 'assessment-answers.json';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  setDownloadName(res, jsonName);
  res.send(JSON.stringify(buildFullExport(Number(req.query && req.query.day_id) || activeDayId()), null, 2));
});

// רשימת הגיבויים הקיימים
app.get('/api/examiner/backups', authExaminer, (req, res) => {
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.json') || f.endsWith('.db'))
    .map((f) => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: st.size, at: st.mtimeMs }; })
    .sort((a, b) => b.at - a.at);
  res.json({ dir: BACKUP_DIR, interval_min: BACKUP_INTERVAL_MIN, files });
});

// גיבוי ידני מיידי
app.post('/api/examiner/backup-now', authExaminer, (req, res) => res.json(makeBackup('manual')));

// הורדת קובץ גיבוי מסוים
app.get('/api/examiner/backup/:name', authExaminer, (req, res) => {
  const name = path.basename(req.params.name || '');
  const full = path.join(BACKUP_DIR, name);
  if (!full.startsWith(BACKUP_DIR) || !fs.existsSync(full)) return res.status(404).json({ error: 'קובץ גיבוי לא נמצא.' });
  res.download(full);
});

// הורדת כל התשובות כקובץ אקסל (קריא, מוכן לבדיקה ידנית או לשליחה)
// שם קובץ בכותרת HTTP חייב להיות ASCII (אחרת Node זורק ERR_INVALID_CHAR והבקשה
// נכשלת ב-500). שולחים שם ASCII בטוח + גרסת UTF-8 תקנית שהדפדפן מעדיף.
function setDownloadName(res, name) {
  const ascii = String(name).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Disposition',
    'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name));
}

function buildAnswerRows(dayId) {
  const examinees = db.prepare('SELECT * FROM examinees WHERE day_id = ? ORDER BY created_at').all(dayId);
  const rows = [];
  for (const ex of examinees) {
    const answers = db.prepare('SELECT * FROM answers WHERE code = ? ORDER BY round, item_id').all(ex.code);
    for (const a of answers) {
      const ch = content.getChapter(a.chapter_id);
      const item = ch && (ch.items || []).find((i) => i.id === a.item_id);
      let questionText = item ? (item.stem || item.prompt || '') : '';
      let answerText = a.answer || '';
      let correct = '';
      if ((a.type === 'mc_apply' || a.type === 'mc_error_dialogue') && item && item.options) {
        const opt = item.options.find((o) => o.id === a.answer);
        answerText = opt ? (opt.text || opt.tex || a.answer) : a.answer;
        correct = opt ? (opt.correct ? 'נכון' : 'לא נכון') : '';
      }
      if (a.dont_know) answerText = '— לא יודע/ת —';
      rows.push({
        'שם': ex.name,
        'קוד': ex.code,
        'סבב': a.round,
        'מקצוע': ch ? ch.subject : '',
        'פרק': a.chapter_id,
        'מזהה שאלה': a.item_id,
        'סוג': a.type,
        'השאלה': questionText,
        'התשובה שנתן/ה': answerText,
        'לא יודע/ת': a.dont_know ? 'כן' : '',
        'נכון (רב-ברירה)': correct,
        'זמן (שניות)': a.time_spent_sec || 0,
        'עודכן': a.updated_at ? new Date(a.updated_at).toLocaleString('he-IL') : '',
      });
    }
  }
  return rows;
}
const ANSWER_HEADER = ['שם', 'קוד', 'סבב', 'מקצוע', 'פרק', 'מזהה שאלה', 'סוג', 'השאלה', 'התשובה שנתן/ה', 'לא יודע/ת', 'נכון (רב-ברירה)', 'זמן (שניות)', 'עודכן'];
const ANSWER_COLS = [{ wch: 16 }, { wch: 8 }, { wch: 5 }, { wch: 12 }, { wch: 22 }, { wch: 10 }, { wch: 16 }, { wch: 40 }, { wch: 50 }, { wch: 10 }, { wch: 14 }, { wch: 11 }, { wch: 18 }];
function answerSheet(rows) {
  const ws = XLSX.utils.json_to_sheet(rows, { header: ANSWER_HEADER });
  ws['!views'] = [{ RTL: true }];
  ws['!cols'] = ANSWER_COLS;
  return ws;
}
// שם גיליון חוקי ב-Excel: עד 31 תווים, בלי : \\ / ? * [ ]
function safeSheetName(name, fallback) {
  let n = String(name || '').replace(/[:\\/?*\[\]]/g, ' ').trim().slice(0, 31);
  return n || fallback;
}

// ייצוא תשובות ל-Excel. ברירת מחדל: היום הפעיל. `day_id=N` ליום מסוים.
// `all_closed=1` → חוברת אחת עם **גיליון לכל יום סגור** (ארכיון).
app.get('/api/examiner/export-excel', authExaminer, (req, res) => {
  const q = req.query || {};
  const wb = XLSX.utils.book_new();
  let filename = 'assessment-answers.xlsx';

  if (String(q.all_closed || '') === '1') {
    const days = db.prepare("SELECT * FROM days WHERE status = 'closed' ORDER BY id").all();
    if (!days.length) return res.status(400).json({ error: 'אין ימים סגורים להורדה.' });
    const used = {};
    days.forEach((d, i) => {
      let nm = safeSheetName(d.name, 'יום ' + d.id);
      if (used[nm]) nm = safeSheetName(nm.slice(0, 27) + ' ' + (i + 1), 'יום ' + d.id);
      used[nm] = true;
      XLSX.utils.book_append_sheet(wb, answerSheet(buildAnswerRows(d.id)), nm);
    });
    filename = 'all-closed-days.xlsx';
  } else {
    const dayId = Number(q.day_id) || activeDayId();
    XLSX.utils.book_append_sheet(wb, answerSheet(buildAnswerRows(dayId)), 'תשובות');
    const d = db.prepare('SELECT name FROM days WHERE id = ?').get(dayId);
    if (d) filename = 'answers-' + safeSheetName(d.name, 'day' + dayId).replace(/\s+/g, '-') + '.xlsx';
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  setDownloadName(res, filename);
  res.send(buf);
});

// ייצוא רשימת נבחנים + קודים אישיים + סבב ריאיון — "גיבוי מקורקע" שהמנהל מחזיק אצלו
app.get('/api/examiner/export-roster', authExaminer, (req, res) => {
  const examinees = db.prepare('SELECT * FROM examinees WHERE day_id = ? ORDER BY created_at').all(Number(req.query && req.query.day_id) || activeDayId());
  const rows = examinees.map((ex) => {
    const marks = db.prepare('SELECT round FROM interview_marks WHERE code = ? ORDER BY round').all(ex.code).map((r) => r.round);
    const subs = JSON.parse(ex.subjects || '[]');
    let decl = null;
    try { decl = JSON.parse(ex.declaration || 'null'); } catch (e) { decl = null; }
    const declSubs = (decl && Array.isArray(decl.subjects)) ? decl.subjects : [];
    const declNote = (decl && typeof decl.note === 'string') ? decl.note : '';
    return {
      'שם': ex.name,
      'קוד אישי (סיסמה)': ex.pin || '',
      'מקצועות למבחן': subs.join(', '),
      'רמת מתמטיקה': ex.math_level || '',
      'מקצועות שהוצהרו': declSubs.join(', '),
      'הערות (הצהרה)': declNote,
      'סבב ריאיון': marks.length ? marks.join(', ') : '',
      'התראיין': ex.interviewed ? 'כן' : '',
      'סטטוס': ex.status === 'left' ? 'עזב' : (ex.status === 'active' ? 'פעיל' : 'רשום'),
    };
  });
  const header = ['שם', 'קוד אישי (סיסמה)', 'מקצועות למבחן', 'רמת מתמטיקה', 'מקצועות שהוצהרו', 'הערות (הצהרה)', 'סבב ריאיון', 'התראיין', 'סטטוס'];
  const ws = XLSX.utils.json_to_sheet(rows, { header });
  ws['!views'] = [{ RTL: true }];
  ws['!cols'] = [{ wch: 18 }, { wch: 16 }, { wch: 28 }, { wch: 12 }, { wch: 34 }, { wch: 30 }, { wch: 11 }, { wch: 9 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'נבחנים');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  setDownloadName(res, 'examinees-roster.xlsx');
  res.send(buf);
});

// דוח תקינות בנק התוכן (שומר הסף) — לצפייה במסך הבוחן
app.get('/api/examiner/content-health', authExaminer, (req, res) => {
  res.json({
    subjects: content.listSubjects(),
    chapters: Array.from(content.byId.values()).map((c) => ({
      chapter_id: c.chapter_id, subject: c.subject, level: c.level, valid: c._valid, issues: c._issues,
    })),
    problems: content.getProblems(),
  });
});

// ============================================================
//  מערכת הבדיקה («מסך בדיקה») — נפרדת מהניהול החי
// ============================================================
const gradingJobs = {}; // cohort_id -> { total, done, failed, running }

function gSafeParse(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; } }
function gIsMc(t) { return t === 'mc_apply' || t === 'mc_error_dialogue'; }
function gIsTeach(t) { return t === 'text_teach' || t === 'text_teach_error'; }

function cohortConfig(cohort) {
  const w = gSafeParse(cohort && cohort.weights_json, null);
  return (w && typeof w === 'object') ? Object.assign({}, score.CONFIG, w) : score.CONFIG;
}
function effectiveItemScores(gi) {
  const human = gSafeParse(gi && gi.human_scores_json, null);
  if (human && Object.keys(human).length) return human;
  return gSafeParse(gi && gi.ai_scores_json, {}) || {};
}
function logGradeAudit(cohortId, code, chapterId, itemId, field, oldV, newV) {
  db.prepare('INSERT INTO grading_audit (cohort_id,code,chapter_id,item_id,field,old,new,by,at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(cohortId, code || null, chapterId || null, itemId || null, field, oldV == null ? null : String(oldV), newV == null ? null : String(newV), 'examiner', now());
}

// בונה את מבנה הפרקים לחישוב score.computeScores עבור נבחן במחזור
function buildChaptersFor(cohortId, code) {
  const answers = db.prepare('SELECT * FROM grading_answers WHERE cohort_id=? AND code=? ORDER BY chapter_id,item_id').all(cohortId, code);
  const items = db.prepare('SELECT * FROM grading_items WHERE cohort_id=? AND code=?').all(cohortId, code);
  const itemMap = {};
  items.forEach((gi) => { itemMap[gi.chapter_id + '|' + gi.item_id] = gi; });
  const byChapter = {};
  answers.forEach((a) => { (byChapter[a.chapter_id] = byChapter[a.chapter_id] || []).push(a); });
  return Object.keys(byChapter).map((chId) => {
    const ch = content.getChapter(chId);
    const its = byChapter[chId].map((a) => {
      if (gIsMc(a.type)) return { type: a.type, mcCorrect: a.correct === 1, dontKnow: !!a.dont_know };
      if (gIsTeach(a.type)) return { type: a.type, dontKnow: !!a.dont_know, scores: effectiveItemScores(itemMap[chId + '|' + a.item_id]) };
      return { type: a.type };
    });
    return { subject: ch ? ch.subject : null, level: ch ? ch.level : null, chapter_id: chId, items: its };
  });
}

function computeAndStoreRollup(cohortId, code, cfg) {
  const gx = db.prepare('SELECT * FROM grading_examinees WHERE cohort_id=? AND code=?').get(cohortId, code);
  const chapters = buildChaptersFor(cohortId, code);
  // ⚠ רמת המתמטיקה נדרשת *בתוך* החישוב — היא קובעת את תקרת הבונוס (5/4/3 יח״ל).
  const r = score.computeScores({ chapters: chapters, mathLevel: gx && gx.math_level }, cfg);
  const rec = score.buildRecommendation(r, { partial: !!(gx && gx.partial) });
  const dom = JSON.stringify(r.domainsLabeled || {});
  const crit = JSON.stringify(r.criteria || {});
  const subj = JSON.stringify(r.perSubject || {});
  // teaching_t = רב-מלל · content_c = המקצוע החזק · final_1to5 = הציון הסופי
  const cols = 'domain_scores_json=?,content_c=?,teaching_t=?,final_1to5=?,breadth_bonus=?,top_domain=?,recommendation=?,bonus=?,bonus_from=?,criteria_json=?,subjects_json=?';
  const vals = [dom, r.content, r.ravMelel, r.final, r.bonus, r.topDomain, rec, r.bonus, r.bonusLabel, crit, subj];
  const exists = db.prepare('SELECT 1 AS x FROM grading_rollups WHERE cohort_id=? AND code=?').get(cohortId, code);
  if (exists) {
    db.prepare('UPDATE grading_rollups SET ' + cols + ' WHERE cohort_id=? AND code=?').run(...vals, cohortId, code);
  } else {
    db.prepare('INSERT INTO grading_rollups (cohort_id,code,domain_scores_json,content_c,teaching_t,final_1to5,breadth_bonus,top_domain,recommendation,bonus,bonus_from,criteria_json,subjects_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(cohortId, code, ...vals);
  }
  return r;
}
function recomputeRanks(cohortId) {
  const rows = db.prepare('SELECT code, final_1to5 FROM grading_rollups WHERE cohort_id=?').all(cohortId)
    .filter((r) => r.final_1to5 != null)
    .sort((a, b) => b.final_1to5 - a.final_1to5);
  const n = rows.length;
  const upd = db.prepare('UPDATE grading_rollups SET rank=?, percentile=? WHERE cohort_id=? AND code=?');
  rows.forEach((r, i) => { upd.run(i + 1, n ? Math.round(((n - i) / n) * 100) : null, cohortId, r.code); });
}
function buildSheetRows(cohortId) {
  const cohort = db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(cohortId) || {};
  const dayLabel = cohort.day_label || cohort.name || '';
  return db.prepare('SELECT * FROM grading_examinees WHERE cohort_id=?').all(cohortId).map((gx) => {
    const roll = db.prepare('SELECT * FROM grading_rollups WHERE cohort_id=? AND code=?').get(cohortId, gx.code) || {};
    const domains = gSafeParse(roll.domain_scores_json, {});
    const subjects = gSafeParse(roll.subjects_json, {});
    // ⚠ ציון אינו תקף עד שכל תשובות הרב-מלל נוקדו. אחרת הגיליון מראה 5.0 לכולם
    // (רק הרב-ברירה נספרה) וזה נראה כמו תוצאה אמיתית.
    const tTot = db.prepare('SELECT COUNT(*) AS n FROM grading_items WHERE cohort_id=? AND code=?').get(cohortId, gx.code).n;
    const tDone = db.prepare("SELECT COUNT(*) AS n FROM grading_items WHERE cohort_id=? AND code=? AND (ai_status='done' OR human_scores_json IS NOT NULL)").get(cohortId, gx.code).n;
    // ⚠ «טרם נבדק» בלי סיבה שלח את המשתמש לחפש. מפרטים כמה חסרים ומה מקורם,
    // כי פריט שנכשל דורש ציון ידני ולא סתם המתנה.
    let pendingReason = '';
    if (tTot > tDone) {
      const nFailed = db.prepare("SELECT COUNT(*) AS n FROM grading_items WHERE cohort_id=? AND code=? AND ai_status='failed' AND human_scores_json IS NULL").get(cohortId, gx.code).n;
      pendingReason = (tTot - tDone) + ' תשובות בלי ציון' + (nFailed ? ' · ' + nFailed + ' נכשלו ודורשות ציון ידני' : ' · טרם רצה בדיקת AI');
    }

    // ★ ציון ידני דורס את המחושב. שדה שלא הוזן נשאר מחושב.
    const man = gSafeParse(gx.manual_scores_json, null);
    const manualFields = [];
    let mFinal = roll.final_1to5, mRav = roll.teaching_t;
    let mQuant = domains['כמותי'] != null ? domains['כמותי'] : null;
    let mEng = domains['אנגלית'] != null ? domains['אנגלית'] : null;
    if (man) {
      if (man.final != null) { mFinal = man.final; manualFields.push('final'); }
      if (man.ravMelel != null) { mRav = man.ravMelel; manualFields.push('ravMelel'); }
      if (man.quant != null) { mQuant = man.quant; manualFields.push('quant'); }
      if (man.english != null) { mEng = man.english; manualFields.push('english'); }
    }
    // ⚠ ציון סופי ידני מבטל את «טרם נבדק». אחרת הנבחנת תדולג בכל ייצוא ובכל
    // שליחה למאנדיי — כלומר הציון שהוזן ידנית לא יגיע לשום מקום, וזו כל המטרה.
    const isPending = (man && man.final != null) ? false : (tTot > tDone);
    if (man && man.final != null) pendingReason = '';

    return {
      pendingReason: pendingReason,
      manual: manualFields.length > 0, manualFields: manualFields,
      // הערכים המחושבים נשמרים לצד הידניים — המסך מציג אותם בטולטיפ ומאפשר לחזור אליהם.
      computed: { final: roll.final_1to5, ravMelel: roll.teaching_t,
        quant: domains['כמותי'] != null ? domains['כמותי'] : null,
        english: domains['אנגלית'] != null ? domains['אנגלית'] : null },
      code: gx.code, name: gx.name, day: dayLabel, cohortId: cohortId,
      include: !!gx.include_in_sheet, locked: !!gx.locked, partial: !!gx.partial,
      teachTotal: tTot, teachGraded: tDone, pending: isPending,
      // ארבע העמודות שהוסכמו: ציון · רב-מלל · כמותי · אנגלית
      final: mFinal, ravMelel: mRav, quant: mQuant, english: mEng,
      bonus: roll.bonus || 0,
      bonusFrom: roll.bonus_from || '',
      // לפני שהבדיקה רצה מוצגים שמות המקצועות בלי ציונים — ציון רב-ברירה בלבד מטעה.
      subjectsLabel: score.subjectsLabel({ perSubject: subjects, subjectLevels: {}, mathLevel: gx.math_level }, tTot <= tDone),
      subjects: subjects,
      criteria: gSafeParse(roll.criteria_json, {}),
      domains: domains, topDomain: roll.top_domain, rank: roll.rank, percentile: roll.percentile,
      recommendation: roll.recommendation || '', note: gx.note || '',
      // תאימות לאחור למסכים שעדיין קוראים teaching/content
      teaching: roll.teaching_t, content: roll.content_c,
    };
  }).sort((a, b) => (b.final || 0) - (a.final || 0));
}

// הקיבוץ לפי (פרק, שאלה) יושב ב-lib/aiGrade.js — לוגיקת בדיקה, לא לוגיקת שרת.
const groupItemsByQuestion = aiGrade.groupItemsByQuestion;

// עבודת הרקע: בודקת פריטי «למד» שטרם נבדקו (resumable), מקובצת לפי שאלה.
async function runGradingJob(cohortId, items, cfg, job) {
  const CONC = 3;
  const groups = groupItemsByQuestion(items, aiGrade.BATCH_SIZE);
  job.groups = groups.length;
  let gidx = 0;
  const affected = new Set();
  const upd = db.prepare('UPDATE grading_items SET ai_scores_json=?, ai_conclusion=?, ai_attention=?, ai_confidence=?, ai_status=?, ai_demo=? WHERE cohort_id=? AND code=? AND chapter_id=? AND item_id=?');
  // ⚠ בלי מפתח API הציונים הם הדגמה לפי אורך התשובה. מסמנים אותם במסד כדי
  // שיהיה אפשר לבדוק אותם מחדש אחרי שמוסיפים מפתח (`only_demo`).
  const isDemo = cfg && cfg.apiKey ? 0 : 1;

  async function worker() {
    while (gidx < groups.length) {
      const group = groups[gidx++];
      const first = group[0];
      const ch = content.getChapter(first.chapter_id);
      const item = ch && (ch.items || []).find((i) => i.id === first.item_id);
      const question = item ? (item.prompt || item.stem || '') : '';
      const sourceText = ch && ch.source ? (ch.source.text || ch.source.tex || '') : '';

      // מפתח אטום a1…a8 — בלי שמות, שהזהות לא תשפיע על השיפוט.
      const asked = group.map((gi, i) => {
        const a = db.prepare('SELECT * FROM grading_answers WHERE cohort_id=? AND code=? AND chapter_id=? AND item_id=?')
          .get(cohortId, gi.code, gi.chapter_id, gi.item_id);
        return { key: 'a' + (i + 1), gi: gi, answer: a ? a.answer : '', dontKnow: a ? !!a.dont_know : false };
      });

      let byKey = {};
      try {
        byKey = await aiGrade.gradeTeachBatch(
          { subject: ch ? ch.subject : '', sourceText: sourceText, question: question },
          asked.map((x) => ({ key: x.key, answer: x.answer, dontKnow: x.dontKnow })), cfg);
      } catch (e) {
        asked.forEach((x) => { byKey[x.key] = { ok: false, criteria: {}, conclusion: 'שגיאה: ' + (e.message || ''), attention: '', confidence: 'low' }; });
      }

      asked.forEach((x) => {
        const r = byKey[x.key] || { ok: false, criteria: {}, conclusion: 'לא חזר ציון לפריט.', attention: 'יש לבדוק ידנית.', confidence: 'low' };
        upd.run(JSON.stringify(r.criteria || {}), r.conclusion || '', r.attention || '', r.confidence || '',
          r.ok ? 'done' : 'failed', isDemo, cohortId, x.gi.code, x.gi.chapter_id, x.gi.item_id);
        affected.add(x.gi.code);
        if (r.ok) job.done++; else job.failed++;   // ההתקדמות נמדדת בפריטים, לא בקריאות
      });
      job.groupsDone = gidx;
    }
  }
  const workers = [];
  for (let i = 0; i < CONC; i++) workers.push(worker());
  await Promise.all(workers);
  const cfg2 = cohortConfig(db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(cohortId));
  affected.forEach((code) => { try { computeAndStoreRollup(cohortId, code, cfg2); } catch (e) { /* לא לשבור */ } });
  recomputeRanks(cohortId);
  job.running = false;
  job.finishedAt = now();
}

// ============================================================
//  יצירת מחזור בדיקה — ליבה משותפת לצילום מהיום החי ולייבוא מקובץ
// ============================================================
// rows = [{ ex:{code,name,subjects,math_level,declaration,status}, ans:[{chapter_id,item_id,type,answer,dont_know,updated_at}] }]
// ⚠ שתי הדרכים חייבות לעבור כאן, כדי ש-`correct` יחושב באותה לוגיקה בדיוק
// ושפריטי «למד» ייכנסו ל-grading_items בשתיהן.
function insertCohortRows(name, rows, opts) {
  opts = opts || {};
  const dayId = (opts.dayId !== undefined) ? opts.dayId : activeDayId();
  if (!rows.length) throw Object.assign(new Error('אין נבחנים לצילום.'), { status: 400 });

  const zeroAnswers = rows.filter((o) => o.ans.length === 0).map((o) => o.ex.name);
  const hashParts = rows.map((o) => o.ex.code + ':' + o.ans.map((a) => a.item_id + '=' + (a.answer || '') + '#' + (a.updated_at || 0) + (a.dont_know ? 'd' : '')).join(','));
  const sourceHash = opts.sourceHash
    || crypto.createHash('sha256').update(hashParts.join('|')).digest('hex').slice(0, 16);
  const existing = db.prepare('SELECT * FROM grading_cohorts WHERE source_hash=? ORDER BY id DESC').get(sourceHash);
  if (existing) {
    // אותם נתונים בדיוק — לא מכפילים. אם ביקשו "ראשי", מסמנים את הקיים.
    if (opts.primary && dayId != null) {
      db.prepare('UPDATE grading_cohorts SET is_primary = 0 WHERE day_id = ?').run(dayId);
      db.prepare('UPDATE grading_cohorts SET is_primary = 1, day_id = ? WHERE id = ?').run(dayId, existing.id);
    }
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM grading_answers WHERE cohort_id = ?').get(existing.id).c;
    const tc = db.prepare('SELECT COUNT(*) AS c FROM grading_items WHERE cohort_id = ?').get(existing.id).c;
    return { cohort_id: existing.id, name: existing.name, reused: true, examinees: rows.length, answers: cnt, teachItems: tc };
  }

  // ⚠ רק נעילות של *אותו יום*. השאילתה הייתה גלובלית, ולכן צילום חוזר של יום
  // שכבר נוקד ונעל יצא עם include=0 לכולם — גיליון Excel ריק לגמרי. וגם נבחנת
  // בשם זהה מיום אחר נעלמה מהגיליון בלי התראה.
  const lockedNames = new Set(
    (dayId == null
      ? []
      : db.prepare(`SELECT ge.name AS name FROM grading_examinees ge
                    JOIN grading_cohorts gc ON gc.id = ge.cohort_id
                    WHERE ge.locked = 1 AND gc.day_id = ?`).all(dayId)
    ).map((r) => normName(r.name)));
  if (opts.primary && dayId != null) db.prepare('UPDATE grading_cohorts SET is_primary = 0 WHERE day_id = ?').run(dayId);
  const info = db.prepare('INSERT INTO grading_cohorts (name, created_at, source_hash, status, weights_json, day_id, is_primary, day_label) VALUES (?,?,?,?,?,?,?,?)')
    .run(name, now(), sourceHash, 'open', JSON.stringify(score.CONFIG), dayId, opts.primary ? 1 : 0, opts.dayLabel || name);
  const cohortId = Number(info.lastInsertRowid);

  const insEx = db.prepare('INSERT INTO grading_examinees (cohort_id,code,name,subjects,math_level,declaration,include_in_sheet,partial) VALUES (?,?,?,?,?,?,?,?)');
  const insAns = db.prepare('INSERT INTO grading_answers (cohort_id,code,chapter_id,item_id,type,answer,correct,dont_know) VALUES (?,?,?,?,?,?,?,?)');
  const insItem = db.prepare('INSERT INTO grading_items (cohort_id,code,chapter_id,item_id,ai_status,status) VALUES (?,?,?,?,?,?)');
  let teachCount = 0, answersCount = 0, skippedChapters = {};
  rows.forEach((o) => {
    const ex = o.ex;
    const include = lockedNames.has(normName(ex.name)) ? 0 : 1;
    insEx.run(cohortId, ex.code, ex.name, ex.subjects || '[]', ex.math_level || null, ex.declaration || null, include,
      (ex.status === 'left' || o.ans.length === 0) ? 1 : 0);
    const seen = new Set();
    o.ans.forEach((a) => {
      // פרק שאינו בבנק התוכן (שונה שם / נמחק) — לא ניתן לנקד אותו. מדלגים ומדווחים.
      if (!content.getChapter(a.chapter_id)) { skippedChapters[a.chapter_id] = (skippedChapters[a.chapter_id] || 0) + 1; return; }
      const key = a.chapter_id + '|' + a.item_id;
      if (seen.has(key)) return;   // כפילות בקובץ מיובא
      seen.add(key);
      let correct = null;
      if (gIsMc(a.type)) { const ok = content.isCorrectChoice(a.chapter_id, a.item_id, a.answer); correct = ok == null ? null : (ok ? 1 : 0); }
      insAns.run(cohortId, ex.code, a.chapter_id, a.item_id, a.type, a.answer, correct, a.dont_know ? 1 : 0);
      answersCount++;
      if (gIsTeach(a.type)) { insItem.run(cohortId, ex.code, a.chapter_id, a.item_id, 'pending', 'pending'); teachCount++; }
    });
  });
  const cfg = cohortConfig(db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(cohortId));
  rows.forEach((o) => computeAndStoreRollup(cohortId, o.ex.code, cfg));
  recomputeRanks(cohortId);
  return { cohort_id: cohortId, name: name, reused: false, examinees: rows.length, answers: answersCount,
    teachItems: teachCount, zero_answers: zeroAnswers,
    skipped_chapters: Object.keys(skippedChapters).length ? skippedChapters : undefined };
}

// צילום-מצב: מעתיק עותק קפוא מהמערכת החיה למחזור בדיקה חדש (idempotent לפי source_hash).
// מוצא כפונקציה כדי ש«שמור יום» יוכל להשתמש בו גם.
function createSnapshot(name, opts) {
  opts = opts || {};
  const dayId = activeDayId();
  // ⚠ כל הנבחנים של היום נכנסים לצילום — גם מי שלא ענה כלום (מסומן partial).
  // אחרת נבחנים "נעלמים" מגיליון הציונים בלי שום התראה.
  const rows = db.prepare('SELECT * FROM examinees WHERE day_id = ? ORDER BY created_at').all(dayId)
    .map((ex) => ({ ex: ex, ans: db.prepare('SELECT * FROM answers WHERE code=? ORDER BY chapter_id,item_id').all(ex.code) }));
  if (!rows.length) throw Object.assign(new Error('אין נבחנים ביום הזה לצילום.'), { status: 400 });
  const day = db.prepare('SELECT name FROM days WHERE id=?').get(dayId);
  return insertCohortRows(name, rows, { dayId: dayId, primary: opts.primary, dayLabel: (day && day.name) || name });
}

// ייבוא יום קודם מקובץ ה-JSON של «הורד את כל התשובות» (buildFullExport).
// יום שלא נמצא בשרת יותר — כמו 2.8, שהמסד נוקה אחריו — נכנס לבדיקה מכאן.
function importCohort(name, payload, opts) {
  opts = opts || {};
  const list = (payload && payload.examinees) || (Array.isArray(payload) ? payload : null);
  if (!Array.isArray(list) || !list.length) {
    throw Object.assign(new Error('הקובץ אינו בפורמט המצופה — חסר "examinees".'), { status: 400 });
  }
  const rows = list.map((e, i) => {
    // הייצוא שומר את השם בשדה "examinee"; code_ref הוא גיבוי אם השם חסר.
    const nm = normName(e.examinee || e.name || e.code_ref || ('נבחן ' + (i + 1)));
    const subjects = Array.isArray(e.subjects) ? JSON.stringify(e.subjects) : (e.subjects || '[]');
    const decl = (e.declaration && typeof e.declaration === 'object') ? JSON.stringify(e.declaration) : (e.declaration || null);
    return {
      ex: { code: String(e.code || ('imp' + i)), name: nm, subjects: subjects,
        math_level: e.math_level != null ? String(e.math_level) : null, declaration: decl, status: e.status || 'active' },
      ans: (e.answers || []).map((a) => ({
        chapter_id: a.chapter_id, item_id: a.item_id, type: a.type,
        answer: a.answer == null ? null : String(a.answer),
        dont_know: a.dont_know ? 1 : 0,
        updated_at: a.updated_at || 0,
      })).filter((a) => a.chapter_id && a.item_id && a.type),
    };
  });
  // חתימה על תוכן הקובץ — ייבוא חוזר של אותו קובץ לא ייצור מחזור כפול.
  const sig = crypto.createHash('sha256')
    .update('import:' + rows.map((r) => r.ex.name + '|' + r.ans.map((a) => a.chapter_id + a.item_id + (a.answer || '')).join(',')).join('||'))
    .digest('hex').slice(0, 16);
  const out = insertCohortRows(name, rows, { dayId: null, primary: false, dayLabel: opts.dayLabel || name, sourceHash: sig });
  // שם שנראה כמו מספר טלפון או מספר זהות — הנבחן/ת הקליד/ה בשדה הלא נכון.
  // עדיף לגלות את זה עכשיו ולא מול גיליון הציונים הסופי.
  const suspicious = rows.map((r) => r.ex.name).filter((n) => /^[\d\-+ ]{6,}$/.test(n));
  if (suspicious.length) out.suspicious_names = suspicious;
  return out;
}

// ייבוא יום קודם מקובץ JSON (הקובץ שמורידים ב«הורד את כל התשובות»).
app.post('/api/examiner/grading/import', authExaminer, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim() || ('יום מיובא ' + new Date().toLocaleDateString('he-IL'));
  try {
    const out = importCohort(name, b.data || b.payload || b, { dayLabel: String(b.day_label || name).trim() });
    res.json(Object.assign({ ok: true, imported: true }, out));
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

app.post('/api/examiner/grading/snapshot', authExaminer, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim() || ('בדיקה ' + new Date().toLocaleDateString('he-IL'));
  try {
    res.json(Object.assign({ ok: true }, createSnapshot(name, { primary: false })));
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

app.get('/api/examiner/grading/cohorts', authExaminer, (req, res) => {
  const cohorts = db.prepare('SELECT * FROM grading_cohorts ORDER BY id DESC').all().map((c) => {
    const exN = db.prepare('SELECT COUNT(*) AS n FROM grading_examinees WHERE cohort_id=?').get(c.id).n;
    const tot = db.prepare('SELECT COUNT(*) AS n FROM grading_items WHERE cohort_id=?').get(c.id).n;
    const done = db.prepare("SELECT COUNT(*) AS n FROM grading_items WHERE cohort_id=? AND ai_status='done'").get(c.id).n;
    const locked = db.prepare('SELECT COUNT(*) AS n FROM grading_examinees WHERE cohort_id=? AND locked=1').get(c.id).n;
    const demoN = db.prepare('SELECT COUNT(*) AS n FROM grading_items WHERE cohort_id=? AND ai_demo=1').get(c.id).n;
    const job = gradingJobs[c.id];
    return { id: c.id, name: c.name, created_at: c.created_at, status: c.status, examinees: exN, teachItems: tot, aiDone: done, demoItems: demoN, locked: locked, running: !!(job && job.running) };
  });
  res.json({ cohorts: cohorts, demo: !aiGrade.hasApiKey() });
});

app.get('/api/examiner/grading/cohort/:id', authExaminer, (req, res) => {
  const id = Number(req.params.id);
  const cohort = db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(id);
  if (!cohort) return res.status(404).json({ error: 'מחזור לא נמצא.' });
  const examinees = db.prepare('SELECT * FROM grading_examinees WHERE cohort_id=? ORDER BY name').all(id).map((gx) => {
    const roll = db.prepare('SELECT * FROM grading_rollups WHERE cohort_id=? AND code=?').get(id, gx.code) || {};
    const tot = db.prepare('SELECT COUNT(*) AS n FROM grading_items WHERE cohort_id=? AND code=?').get(id, gx.code).n;
    const done = db.prepare("SELECT COUNT(*) AS n FROM grading_items WHERE cohort_id=? AND code=? AND ai_status='done'").get(id, gx.code).n;
    const reviewed = db.prepare("SELECT COUNT(*) AS n FROM grading_items WHERE cohort_id=? AND code=? AND status IN ('approved','edited')").get(id, gx.code).n;
    return { code: gx.code, name: gx.name, subjects: gSafeParse(gx.subjects, []), locked: !!gx.locked, include: !!gx.include_in_sheet, partial: !!gx.partial,
      teachTotal: tot, aiDone: done, reviewed: reviewed, final: roll.final_1to5, teaching: roll.teaching_t, content: roll.content_c, topDomain: roll.top_domain, rank: roll.rank };
  });
  const failed = db.prepare("SELECT COUNT(*) AS n FROM grading_items WHERE cohort_id=? AND ai_status='failed'").get(id).n;
  const demoItems = db.prepare('SELECT COUNT(*) AS n FROM grading_items WHERE cohort_id=? AND ai_demo=1').get(id).n;
  res.json({ cohort: { id: cohort.id, name: cohort.name, status: cohort.status, created_at: cohort.created_at },
    examinees: examinees, failed: failed, demoItems: demoItems, demo: !aiGrade.hasApiKey(), job: gradingJobs[id] || null });
});

// בדיקת חיבור — קריאה אחת זולה לפני שמשגרים עשרות. חובה לפני הרצה מלאה.
app.get('/api/examiner/grading/test-key', authExaminer, async (req, res) => {
  const cfg = aiGrade.loadConfig();
  const r = await aiGrade.testKey(cfg);
  res.json(Object.assign({ model: cfg.model, effort: cfg.effort }, r));
});

app.post('/api/examiner/grading/run-ai', authExaminer, (req, res) => {
  const id = Number(req.body && req.body.cohort_id);
  const cohort = db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(id);
  if (!cohort) return res.status(404).json({ error: 'מחזור לא נמצא.' });
  if (gradingJobs[id] && gradingJobs[id].running) return res.json({ ok: true, already: true, job: gradingJobs[id] });
  const cfg = aiGrade.loadConfig();
  // ⚠ המלכודת החמורה ביותר במסך הזה: הרצה בלי מפתח API כותבת ציוני הדגמה
  // (לפי אורך התשובה בלבד) עם ai_status='done'. מכיוון ש-run-ai בוחר רק
  // ai_status!='done', לחיצה חוזרת *אחרי* הוספת המפתח הייתה מחזירה «הכול כבר
  // נבדק» — והנתונים המזויפים היו נשארים בלי שאיש ידע. לכן: חסימה מפורשת.
  const confirmDemo = !!(req.body && req.body.confirm_demo);
  if (!cfg.apiKey && !confirmDemo) {
    return res.status(400).json({
      demo_block: true,
      error: 'לא הוגדר מפתח API (ANTHROPIC_API_KEY). הרצה עכשיו תיתן ציוני הדגמה לפי אורך התשובה בלבד — לא לפי התוכן.',
    });
  }
  // only_failed → «נסה שוב את מה שנכשל». only_demo → בדיקה מחדש של ציוני הדגמה.
  const onlyFailed = !!(req.body && req.body.only_failed);
  const onlyDemo = !!(req.body && req.body.only_demo);
  if (onlyDemo) {
    // מחזירים אותם ל-pending כדי שהמנוע יתייחס אליהם כאילו לא נבדקו מעולם.
    db.prepare("UPDATE grading_items SET ai_status='pending' WHERE cohort_id=? AND ai_demo=1").run(id);
  }
  const pending = onlyFailed
    ? db.prepare("SELECT * FROM grading_items WHERE cohort_id=? AND ai_status='failed'").all(id)
    : onlyDemo
      ? db.prepare("SELECT * FROM grading_items WHERE cohort_id=? AND ai_demo=1").all(id)
      : db.prepare("SELECT * FROM grading_items WHERE cohort_id=? AND ai_status!='done'").all(id);
  if (!pending.length) return res.json({ ok: true, nothing: true, total: 0 });
  const groups = groupItemsByQuestion(pending, aiGrade.BATCH_SIZE).length;
  const job = { total: pending.length, done: 0, failed: 0, running: true, startedAt: now(), groups: groups, groupsDone: 0, demo: !cfg.apiKey };
  gradingJobs[id] = job;
  runGradingJob(id, pending, cfg, job).catch((e) => { job.running = false; job.error = String(e && e.message); });
  res.json({ ok: true, started: true, total: pending.length, groups: groups, demo: !cfg.apiKey });
});

app.get('/api/examiner/grading/progress/:id', authExaminer, (req, res) => {
  const id = Number(req.params.id);
  const tot = db.prepare('SELECT COUNT(*) AS n FROM grading_items WHERE cohort_id=?').get(id).n;
  const done = db.prepare("SELECT COUNT(*) AS n FROM grading_items WHERE cohort_id=? AND ai_status='done'").get(id).n;
  const failed = db.prepare("SELECT COUNT(*) AS n FROM grading_items WHERE cohort_id=? AND ai_status='failed'").get(id).n;
  const job = gradingJobs[id] || null;
  res.json({ job: job, total: tot, done: done, failed: failed, running: !!(job && job.running) });
});

app.get('/api/examiner/grading/examinee/:cohort/:code', authExaminer, (req, res) => {
  const cohortId = Number(req.params.cohort);
  const code = req.params.code;
  const cohort = db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(cohortId);
  const gx = db.prepare('SELECT * FROM grading_examinees WHERE cohort_id=? AND code=?').get(cohortId, code);
  if (!cohort || !gx) return res.status(404).json({ error: 'לא נמצא.' });
  const answers = db.prepare('SELECT * FROM grading_answers WHERE cohort_id=? AND code=? ORDER BY chapter_id,item_id').all(cohortId, code);
  const items = db.prepare('SELECT * FROM grading_items WHERE cohort_id=? AND code=?').all(cohortId, code);
  const itemMap = {}; items.forEach((gi) => { itemMap[gi.chapter_id + '|' + gi.item_id] = gi; });
  const byChapter = {}; answers.forEach((a) => { (byChapter[a.chapter_id] = byChapter[a.chapter_id] || []).push(a); });
  const chapters = Object.keys(byChapter).map((chId) => {
    const ch = content.getChapter(chId);
    const its = byChapter[chId].map((a) => {
      const item = ch && (ch.items || []).find((i) => i.id === a.item_id);
      const base = { item_id: a.item_id, type: a.type, dont_know: !!a.dont_know, question: item ? (item.prompt || item.stem || '') : '' };
      if (gIsMc(a.type)) {
        let chosenText = a.answer;
        let correctText = '';
        if (item && item.options) {
          const opt = item.options.find((o) => o.id === a.answer);
          if (opt) chosenText = opt.text || opt.tex || a.answer;
          const right = item.options.find((o) => o.correct);
          if (right) correctText = right.text || right.tex || '';
        }
        base.mc = { chosen: chosenText, correct: a.correct === 1, correctText: correctText, dontKnow: !!a.dont_know };
      } else if (gIsTeach(a.type)) {
        const gi = itemMap[chId + '|' + a.item_id] || {};
        base.teach = {
          answer: a.answer || '',
          ai: gSafeParse(gi.ai_scores_json, {}), aiConclusion: gi.ai_conclusion || '', aiAttention: gi.ai_attention || '', aiConfidence: gi.ai_confidence || '', aiStatus: gi.ai_status || 'pending',
          human: gSafeParse(gi.human_scores_json, null), note: gi.human_note || '', status: gi.status || 'pending',
        };
      }
      return base;
    });
    return { chapter_id: chId, subject: ch ? ch.subject : '', level: ch ? ch.level : '', source: ch && ch.source ? (ch.source.text || ch.source.tex || '') : '', items: its };
  });
  const cfg = cohortConfig(cohort);
  const roll = computeAndStoreRollup(cohortId, code, cfg);
  recomputeRanks(cohortId);
  const order = db.prepare('SELECT code FROM grading_examinees WHERE cohort_id=? ORDER BY name').all(cohortId);
  const pos = order.findIndex((o) => o.code === code);
  res.json({
    cohort: { id: cohort.id, name: cohort.name },
    examinee: { code: gx.code, name: gx.name, subjects: gSafeParse(gx.subjects, []), math_level: gx.math_level, locked: !!gx.locked, include: !!gx.include_in_sheet, note: gx.note || '', partial: !!gx.partial },
    chapters: chapters, rollup: roll,
    criteria: score.CRITERION_LABEL, criteriaOrder: score.CRITERIA, axis: score.AXIS_OF,
    nav: { prev: pos > 0 ? order[pos - 1].code : null, next: pos < order.length - 1 ? order[pos + 1].code : null, index: pos + 1, count: order.length },
    demo: !aiGrade.hasApiKey(),
  });
});

// ============================================================
//  בדיקה «לפי שאלה» — כל התשובות לאותה שאלה זו מתחת לזו
// ============================================================
// הרבה יותר מהיר ועקבי מלעבור נבחן-נבחן: העין מכיילת את עצמה על אותה שאלה
// במקום לקפוץ בין מקצועות. גם תואם לאופן שבו ה-AI בדק (מקובץ לפי שאלה).

// פריט «למד» q1t מזווג לרב-ברירה q1 (מוסכמה בבנק התוכן: אותו מספר + t).
function mcPeerId(itemId) {
  return /t$/.test(itemId) ? itemId.replace(/t$/, '') : null;
}
// האם הפריט דורש עין אנושית: ביטחון נמוך · ה-AI ביקש לשים לב · בדיקה נכשלה ·
// או סתירה — ענה נכון ברב-ברירה אבל ההסבר שגוי (דיוק ≤2).
// ⚠ במצב הדגמה כל הציונים מסומנים ביטחון נמוך, ולכן הכלל הזה מדלג — אחרת
// כל 305 הפריטים היו מסומנים והמסנן היה מאבד את כל התועלת שלו.
function itemNeedsAttention(gi, mcCorrect, demo) {
  if (!gi) return false;
  if (gi.ai_status === 'failed') return true;
  if (!demo && gi.ai_confidence === 'low') return true;
  if (String(gi.ai_attention || '').trim()) return true;
  const eff = effectiveItemScores(gi);
  if (mcCorrect === true && typeof eff.accuracy === 'number' && eff.accuracy <= 2) return true;
  return false;
}

app.get('/api/examiner/grading/questions/:cohort', authExaminer, (req, res) => {
  const cohortId = Number(req.params.cohort);
  const cohort = db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(cohortId);
  if (!cohort) return res.status(404).json({ error: 'מחזור לא נמצא.' });
  const demo = !aiGrade.hasApiKey();
  const rows = db.prepare('SELECT chapter_id, item_id, COUNT(*) AS n FROM grading_items WHERE cohort_id=? GROUP BY chapter_id, item_id').all(cohortId);
  const questions = rows.map((r) => {
    const ch = content.getChapter(r.chapter_id);
    const item = ch && (ch.items || []).find((i) => i.id === r.item_id);
    const items = db.prepare('SELECT * FROM grading_items WHERE cohort_id=? AND chapter_id=? AND item_id=?').all(cohortId, r.chapter_id, r.item_id);
    const mcId = mcPeerId(r.item_id);
    let attention = 0;
    items.forEach((gi) => {
      let mcCorrect = null;
      if (mcId) {
        const a = db.prepare('SELECT correct FROM grading_answers WHERE cohort_id=? AND code=? AND chapter_id=? AND item_id=?').get(cohortId, gi.code, r.chapter_id, mcId);
        if (a) mcCorrect = a.correct === 1;
      }
      if (itemNeedsAttention(gi, mcCorrect, demo)) attention++;
    });
    return {
      chapter_id: r.chapter_id, item_id: r.item_id,
      subject: ch ? ch.subject : r.chapter_id, level: ch ? ch.level : null,
      archived: !!(ch && ch._archived),
      question: item ? (item.prompt || item.stem || '') : '',
      total: r.n,
      aiDone: items.filter((gi) => gi.ai_status === 'done').length,
      approved: items.filter((gi) => gi.status === 'approved').length,
      attention: attention,
    };
  }).sort((a, b) => (a.subject || '').localeCompare(b.subject || '', 'he') || a.chapter_id.localeCompare(b.chapter_id) || a.item_id.localeCompare(b.item_id));
  res.json({ cohort: { id: cohort.id, name: cohort.name }, questions: questions, demo: demo });
});

app.get('/api/examiner/grading/question/:cohort/:chapter/:item', authExaminer, (req, res) => {
  const cohortId = Number(req.params.cohort);
  const chapterId = req.params.chapter;
  const itemId = req.params.item;
  const cohort = db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(cohortId);
  if (!cohort) return res.status(404).json({ error: 'מחזור לא נמצא.' });
  const ch = content.getChapter(chapterId);
  const item = ch && (ch.items || []).find((i) => i.id === itemId);
  const mcId = mcPeerId(itemId);
  const mcItem = mcId && ch ? (ch.items || []).find((i) => i.id === mcId) : null;

  const demo = !aiGrade.hasApiKey();
  const gitems = db.prepare('SELECT * FROM grading_items WHERE cohort_id=? AND chapter_id=? AND item_id=?').all(cohortId, chapterId, itemId);
  const answers = gitems.map((gi) => {
    const gx = db.prepare('SELECT name, locked FROM grading_examinees WHERE cohort_id=? AND code=?').get(cohortId, gi.code) || {};
    const a = db.prepare('SELECT * FROM grading_answers WHERE cohort_id=? AND code=? AND chapter_id=? AND item_id=?').get(cohortId, gi.code, chapterId, itemId);
    let mc = null;
    if (mcId) {
      const m = db.prepare('SELECT * FROM grading_answers WHERE cohort_id=? AND code=? AND chapter_id=? AND item_id=?').get(cohortId, gi.code, chapterId, mcId);
      if (m) {
        let chosenText = m.answer;
        if (mcItem && mcItem.options) {
          const opt = mcItem.options.find((o) => o.id === m.answer);
          if (opt) chosenText = opt.text || opt.tex || m.answer;
        }
        mc = { correct: m.correct === 1, chosen: chosenText, dontKnow: !!m.dont_know };
      }
    }
    const eff = effectiveItemScores(gi);
    return {
      code: gi.code, name: gx.name || gi.code, examineeLocked: !!gx.locked,
      answer: (a && a.answer) || '', dontKnow: !!(a && a.dont_know),
      ai: gSafeParse(gi.ai_scores_json, {}), human: gSafeParse(gi.human_scores_json, null),
      aiConclusion: gi.ai_conclusion || '', aiAttention: gi.ai_attention || '',
      aiConfidence: gi.ai_confidence || '', aiStatus: gi.ai_status || 'pending',
      note: gi.human_note || '', status: gi.status || 'pending',
      mc: mc,
      needsAttention: itemNeedsAttention(gi, mc ? mc.correct : null, demo),
      // מיון לפי ציון ה-AI — כך רואים אם הסולם עקבי לאורך אותה שאלה
      sortKey: (typeof eff.accuracy === 'number' ? eff.accuracy : 0) + (typeof eff.clarity === 'number' ? eff.clarity : 0),
    };
  }).sort((a, b) => b.sortKey - a.sortKey || (a.name || '').localeCompare(b.name || '', 'he'));

  // ניווט בין שאלות באותו סדר של מסך הרשימה
  const order = db.prepare('SELECT chapter_id, item_id FROM grading_items WHERE cohort_id=? GROUP BY chapter_id, item_id').all(cohortId)
    .map((r) => Object.assign(r, { subject: (content.getChapter(r.chapter_id) || {}).subject || r.chapter_id }))
    .sort((a, b) => (a.subject || '').localeCompare(b.subject || '', 'he') || a.chapter_id.localeCompare(b.chapter_id) || a.item_id.localeCompare(b.item_id));
  const pos = order.findIndex((o) => o.chapter_id === chapterId && o.item_id === itemId);

  res.json({
    cohort: { id: cohort.id, name: cohort.name },
    question: {
      chapter_id: chapterId, item_id: itemId,
      subject: ch ? ch.subject : chapterId, level: ch ? ch.level : null,
      archived: !!(ch && ch._archived),
      text: item ? (item.prompt || item.stem || '') : '',
      source: ch && ch.source ? (ch.source.text || ch.source.tex || '') : '',
      mcText: mcItem ? (mcItem.stem || mcItem.prompt || '') : '',
      mcCorrectText: mcItem && mcItem.options ? ((mcItem.options.find((o) => o.correct) || {}).text || '') : '',
    },
    answers: answers,
    criteria: score.CRITERION_LABEL, criteriaOrder: score.CRITERIA, axis: score.AXIS_OF,
    nav: {
      prev: pos > 0 ? order[pos - 1] : null,
      next: pos >= 0 && pos < order.length - 1 ? order[pos + 1] : null,
      index: pos + 1, count: order.length,
    },
    demo: demo,
  });
});

// אישור קבוצתי — שאלה שלמה / נבחן שלם / מחזור שלם.
// only_untouched=true (ברירת מחדל) מאשר רק פריטים שלא נגעו בהם, כדי שלחיצה
// אחת לא תדרוס שיקול דעת אנושי שכבר הופעל.
app.post('/api/examiner/grading/approve-bulk', authExaminer, (req, res) => {
  const b = req.body || {};
  const cohortId = Number(b.cohort_id);
  const cohort = db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(cohortId);
  if (!cohort) return res.status(404).json({ error: 'מחזור לא נמצא.' });
  const onlyUntouched = b.only_untouched !== false;

  let where = 'cohort_id=?', params = [cohortId];
  if (b.scope === 'question') {
    if (!b.chapter_id || !b.item_id) return res.status(400).json({ error: 'חסרים פרק ושאלה.' });
    where += ' AND chapter_id=? AND item_id=?'; params.push(String(b.chapter_id), String(b.item_id));
  } else if (b.scope === 'examinee') {
    if (!b.code) return res.status(400).json({ error: 'חסר קוד נבחן.' });
    where += ' AND code=?'; params.push(String(b.code));
  } else if (b.scope !== 'cohort') {
    return res.status(400).json({ error: 'scope חייב להיות question / examinee / cohort.' });
  }
  // ⚠ אין מה לאשר פריט שה-AI עוד לא בדק — אין ציון לאשר.
  where += " AND ai_status='done'";
  if (onlyUntouched) where += " AND status='pending' AND human_scores_json IS NULL";

  const targets = db.prepare('SELECT code, chapter_id, item_id FROM grading_items WHERE ' + where).all(...params);
  db.prepare("UPDATE grading_items SET status='approved' WHERE " + where).run(...params);
  targets.forEach((t) => logGradeAudit(cohortId, t.code, t.chapter_id, t.item_id, 'status', 'pending', 'approved'));

  const cfg = cohortConfig(cohort);
  const codes = new Set(targets.map((t) => t.code));
  codes.forEach((c) => { try { computeAndStoreRollup(cohortId, c, cfg); } catch (e) { /* לא לשבור */ } });
  recomputeRanks(cohortId);
  res.json({ ok: true, approved: targets.length });
});

app.post('/api/examiner/grading/item', authExaminer, (req, res) => {
  const b = req.body || {};
  const cohortId = Number(b.cohort_id);
  const gi = db.prepare('SELECT * FROM grading_items WHERE cohort_id=? AND code=? AND chapter_id=? AND item_id=?').get(cohortId, b.code, b.chapter_id, b.item_id);
  if (!gi) return res.status(404).json({ error: 'פריט לא נמצא.' });
  let humanJson = gi.human_scores_json;   // שומרים על מצב העריכה הקיים — לא מעתיקים ציוני AI סתם לתוך "ציון אנושי"
  let changed = false;
  if (b.scores && typeof b.scores === 'object') {
    const human = gSafeParse(gi.human_scores_json, null) || gSafeParse(gi.ai_scores_json, {}) || {};
    Object.keys(b.scores).forEach((k) => {
      const v = Math.max(1, Math.min(5, Math.round(Number(b.scores[k]))));
      if (isFinite(v) && human[k] !== v) { logGradeAudit(cohortId, b.code, b.chapter_id, b.item_id, k, human[k], v); human[k] = v; changed = true; }
    });
    if (changed) humanJson = JSON.stringify(human);
  }
  const note = (b.note != null) ? String(b.note).slice(0, 1000) : gi.human_note;
  const wasEdited = !!humanJson;
  // ⚠ פריט שנכשל בבדיקת ה-AI ואין לו ציון אנושי — «אשר» עליו היה משנה רק את
  // `status` בלי לכתוב ציון, והנבחן היה נשאר «טרם נבדק» בגיליון לנצח בלי שום
  // חיווי (`pending` דורש ai_status='done' OR human_scores_json IS NOT NULL).
  if (b.approve === true && gi.ai_status === 'failed' && !humanJson) {
    return res.status(400).json({
      needs_manual_score: true,
      error: 'הפריט נכשל בבדיקת ה-AI. יש לתת לו ציון ידני (לחיצה על הנקודות) לפני האישור — אחרת הנבחן יישאר בלי ציון סופי.',
    });
  }
  let status = gi.status;
  if (b.approve === true) status = 'approved';                                   // נעילת השאלה (גם אם נערכה)
  else if (b.approve === false) status = wasEdited ? 'edited' : 'pending';        // פתיחת השאלה מחדש
  else if (wasEdited) status = 'edited';
  db.prepare('UPDATE grading_items SET human_scores_json=?, human_note=?, status=? WHERE cohort_id=? AND code=? AND chapter_id=? AND item_id=?')
    .run(humanJson, note, status, cohortId, b.code, b.chapter_id, b.item_id);
  const cfg = cohortConfig(db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(cohortId));
  const roll = computeAndStoreRollup(cohortId, b.code, cfg);
  recomputeRanks(cohortId);
  res.json({ ok: true, rollup: roll, status: status });
});

app.post('/api/examiner/grading/lock', authExaminer, (req, res) => {
  const b = req.body || {};
  const cohortId = Number(b.cohort_id);
  const gx = db.prepare('SELECT * FROM grading_examinees WHERE cohort_id=? AND code=?').get(cohortId, b.code);
  if (!gx) return res.status(404).json({ error: 'לא נמצא.' });
  const locked = b.locked ? 1 : 0;
  // ⚠ נעילה מאשרת אוטומטית את מה שנשאר pending — אבל *לא* פריט שנכשל ואין לו
  // ציון ידני. אחרת הנבחן היה נראה «ננעל ✓» ובכל זאת בלי ציון סופי בגיליון.
  if (locked) {
    db.prepare("UPDATE grading_items SET status='approved' WHERE cohort_id=? AND code=? AND status='pending' AND NOT (ai_status='failed' AND human_scores_json IS NULL)").run(cohortId, b.code);
  }
  const stuck = db.prepare("SELECT COUNT(*) AS n FROM grading_items WHERE cohort_id=? AND code=? AND ai_status='failed' AND human_scores_json IS NULL").get(cohortId, b.code).n;
  db.prepare('UPDATE grading_examinees SET locked=?, reviewer=? WHERE cohort_id=? AND code=?').run(locked, 'examiner', cohortId, b.code);
  logGradeAudit(cohortId, b.code, null, null, 'locked', gx.locked, locked);
  const cfg = cohortConfig(db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(cohortId));
  const roll = computeAndStoreRollup(cohortId, b.code, cfg);
  recomputeRanks(cohortId);
  res.json({ ok: true, locked: !!locked, rollup: roll, stuck_failed: stuck });
});

app.post('/api/examiner/grading/examinee-flags', authExaminer, (req, res) => {
  const b = req.body || {};
  const cohortId = Number(b.cohort_id);
  const gx = db.prepare('SELECT * FROM grading_examinees WHERE cohort_id=? AND code=?').get(cohortId, b.code);
  if (!gx) return res.status(404).json({ error: 'לא נמצא.' });
  const include = (b.include != null) ? (b.include ? 1 : 0) : gx.include_in_sheet;
  const note = (b.note != null) ? String(b.note).slice(0, 2000) : gx.note;
  // ⚠ תיקון שם *בתוך הצילום*. נדרש כי הצילום קפוא ו-`edit-examinee` נוגע רק
  // בנבחני היום החי — ויש נבחנים שנרשמו עם מספר טלפון במקום שם, מה שחוסם את
  // ההתאמה לבורד במאנדיי.
  let name = gx.name;
  if (b.name != null) {
    const nm = String(b.name).trim().slice(0, 120);
    if (!nm) return res.status(400).json({ error: 'שם ריק.' });
    name = nm;
  }
  db.prepare('UPDATE grading_examinees SET include_in_sheet=?, note=?, name=? WHERE cohort_id=? AND code=?').run(include, note, name, cohortId, b.code);
  if (name !== gx.name) logGradeAudit(cohortId, b.code, null, null, 'name', gx.name, name);
  res.json({ ok: true, name: name });
});

// ציון ידני שדורס את המחושב.
// ⚠ נדרש כשאותה נבחנת נרשמה פעמיים וחלק מהפרקים נענו תחת כל שם — אז שני
// הציונים המחושבים שגויים ורק אדם יכול להכריע. כל דריסה נרשמת ב-audit.
app.post('/api/examiner/grading/manual-score', authExaminer, (req, res) => {
  const b = req.body || {};
  const cohortId = Number(b.cohort_id);
  const gx = db.prepare('SELECT * FROM grading_examinees WHERE cohort_id=? AND code=?').get(cohortId, String(b.code || ''));
  if (!gx) return res.status(404).json({ error: 'לא נמצא.' });
  const before = gSafeParse(gx.manual_scores_json, null);

  if (b.clear) {
    db.prepare('UPDATE grading_examinees SET manual_scores_json=NULL WHERE cohort_id=? AND code=?').run(cohortId, gx.code);
    logGradeAudit(cohortId, gx.code, null, null, 'manual_score', JSON.stringify(before), 'ניקוי');
    return res.json({ ok: true, cleared: true });
  }

  const FIELDS = ['final', 'ravMelel', 'quant', 'english'];
  const out = {};
  for (const f of FIELDS) {
    const raw = (b.scores || {})[f];
    if (raw == null || raw === '') continue;      // לא הוזן — נשאר מחושב
    const n = Number(raw);
    if (!isFinite(n) || n < 1 || n > 5) return res.status(400).json({ error: 'הציון של «' + f + '» חייב להיות בין 1 ל-5.' });
    out[f] = Math.round(n * 10) / 10;             // עשירית אחת, כמו המחושב
  }
  if (!Object.keys(out).length) return res.status(400).json({ error: 'לא הוזן אף ציון.' });

  db.prepare('UPDATE grading_examinees SET manual_scores_json=? WHERE cohort_id=? AND code=?').run(JSON.stringify(out), cohortId, gx.code);
  logGradeAudit(cohortId, gx.code, null, null, 'manual_score', JSON.stringify(before), JSON.stringify(out));
  res.json({ ok: true, manual: out });
});

app.post('/api/examiner/grading/recompute', authExaminer, (req, res) => {
  const cohortId = Number(req.body && req.body.cohort_id);
  const cohort = db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(cohortId);
  if (!cohort) return res.status(404).json({ error: 'לא נמצא.' });
  const cfg = cohortConfig(cohort);
  db.prepare('SELECT code FROM grading_examinees WHERE cohort_id=?').all(cohortId).forEach((r) => { try { computeAndStoreRollup(cohortId, r.code, cfg); } catch (e) { /* דלג */ } });
  recomputeRanks(cohortId);
  res.json({ ok: true });
});

app.get('/api/examiner/grading/sheet/:id', authExaminer, (req, res) => {
  const id = Number(req.params.id);
  const cohort = db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(id);
  if (!cohort) return res.status(404).json({ error: 'מחזור לא נמצא.' });
  res.json({ cohort: { id: cohort.id, name: cohort.name, status: cohort.status }, rows: buildSheetRows(id) });
});

// ארבע עמודות הציון שהוסכמו: ציון · רב-מלל · כמותי · אנגלית (+בונוס ומקצועות).
// ⚠ נבחן שתשובות הרב-מלל שלו טרם נוקדו מקבל «טרם נבדק» ולא מספר — אחרת גיליון
// לפני בדיקת ה-AI מציג 5.0 לכולם (רק הרב-ברירה נספרה) וזה נראה אמיתי.
const SHEET_HEADER = ['שם', 'יום', 'ציון', 'רב-מלל', 'כמותי', 'אנגלית', 'בונוס', 'מקצועות',
  'דירוג', 'אחוזון', 'המלצה', 'הערות בודק', 'מבחן חלקי'];
const SHEET_COLS = [{ wch: 20 }, { wch: 12 }, { wch: 7 }, { wch: 8 }, { wch: 7 }, { wch: 8 }, { wch: 7 },
  { wch: 34 }, { wch: 7 }, { wch: 8 }, { wch: 46 }, { wch: 24 }, { wch: 10 }];
function sheetRowToExcel(r) {
  const n = (v) => (v != null ? v : '');
  const g = (v) => (r.pending ? 'טרם נבדק' : n(v));
  return {
    'שם': r.name,
    'יום': r.day || '',
    'ציון': g(r.final),
    'רב-מלל': g(r.ravMelel),
    'כמותי': g(r.quant),
    'אנגלית': g(r.english),
    'בונוס': r.pending ? '' : (r.bonus ? '+' + r.bonus.toFixed(2).replace(/0$/, '') : ''),
    'מקצועות': r.subjectsLabel || '',
    'דירוג': r.pending ? '' : (r.rank || ''),
    'אחוזון': r.pending ? '' : n(r.percentile),
    'המלצה': r.pending ? 'ממתין לבדיקת התשובות הכתובות' : (r.recommendation || ''),
    'הערות בודק': r.note || '',
    'מבחן חלקי': r.partial ? 'כן' : '',
  };
}
function writeSheetBook(sheets) {
  const wb = XLSX.utils.book_new();
  const used = new Set();
  sheets.forEach(function (s, i) {
    const ws = XLSX.utils.json_to_sheet(s.rows.map(sheetRowToExcel), { header: SHEET_HEADER });
    ws['!views'] = [{ RTL: true }];
    ws['!cols'] = SHEET_COLS;
    // ⚠ slice(0,30) לבדו הפיל את הייצוא: תווית יום עם : \ / ? * [ ] או שתי
    // תוויות שנחתכות לאותו טקסט גורמות ל-book_append_sheet לזרוק.
    let title = safeSheetName(s.title, 'גיליון ' + (i + 1));
    while (used.has(title)) title = safeSheetName(title.slice(0, 27) + '_' + (i + 1), 'גיליון ' + (i + 1));
    used.add(title);
    XLSX.utils.book_append_sheet(wb, ws, title);
  });
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
// מיון אופציונלי לפי שם — המסלול לייבוא-קובץ במאנדיי (שמתאים לפי שם).
// בלי הפרמטר נשמר הסדר ההיסטורי: ציון יורד.
function sortSheetRows(rows, mode) {
  if (mode !== 'name') return rows;
  return rows.slice().sort((a, b) => nameMatch.normBasic(a.name).localeCompare(nameMatch.normBasic(b.name), 'he'));
}

// ============================================================
//  ייצוא למאנדיי — «הבורד קובע את סדר השורות»
// ============================================================
// הקושי בהדבקה לבורד קיים הוא *יישור שורות*, לא הפורמט: הגיליון שלנו ממוין
// לפי ציון יורד, והבורד ממוין איך שהוא ממוין. במקום לנחש — המשתמש מדביק את
// עמודת השם מהבורד, ואנחנו מחזירים בדיוק אותן שורות, באותו סדר.
// שורה שלא הותאמה חוזרת *ריקה אבל קיימת*, אחרת כל מה שאחריה יזוז.
const MONDAY_COLS = ['ציון', 'רב-מלל', 'כמותי', 'אנגלית'];

app.post('/api/examiner/grading/monday-match', authExaminer, (req, res) => {
  const b = req.body || {};
  const wantKeys = Array.isArray(b.keys);
  const names = Array.isArray(b.names) ? b.names : String(b.names || '').split('\n');
  if (!wantKeys && !names.length) return res.status(400).json({ error: 'לא הודבקו שמות.' });
  if (names.length > 2000) return res.status(400).json({ error: 'יותר מדי שורות (מקסימום 2000).' });

  // ברירת מחדל: כל המחזורים — הבורד בדרך כלל מכיל את כל ימי ההערכה יחד.
  // ⚠ חובה לנקות כפילויות: אותו מזהה פעמיים היה מכניס כל נבחן פעמיים לבריכה,
  // וכל שם היה נראה «מעורפל» בלי סיבה.
  let ids = Array.isArray(b.cohorts) ? Array.from(new Set(b.cohorts.map(Number).filter(Boolean))) : [];
  if (!ids.length) ids = db.prepare('SELECT id FROM grading_cohorts ORDER BY id').all().map((c) => c.id);

  // כל השורות מכל המחזורים, מאותו מקור בדיוק שבונה את הגיליון — כדי שלא יהיו
  // שני מספרים שונים לאותו אדם.
  const pool = [];
  for (const id of ids) {
    const cohort = db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(id);
    if (!cohort) continue;
    buildSheetRows(id).forEach((r) => pool.push(Object.assign({ cohort_id: id }, r)));
  }
  // מפתח ההתאמה חייב להיות ייחודי בין מחזורים — code לבדו חוזר בין ימים.
  const candidates = pool.map((r) => ({ code: r.cohort_id + ':' + r.code, name: r.name }));
  const byKey = {};
  pool.forEach((r) => { byKey[r.cohort_id + ':' + r.code] = r; });

  // ⚠ מספרים בלבד. עמודת Number במאנדיי דוחה את המחרוזת «טרם נבדק».
  // ההמלצה היא שורה אחת, אבל מנקים טאב/שורה חדשה בכל מקרה — הן היו שוברות
  // גם את ה-TSV וגם את קובץ הייבוא.
  const oneLine = (s) => String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim();
  const vals = (r) => (r && !r.pending
    ? { final: r.final, ravMelel: r.ravMelel, quant: r.quant, english: r.english, recommendation: oneLine(r.recommendation) }
    : { final: null, ravMelel: null, quant: null, english: null, recommendation: '' });
  const brief = (key) => {
    const r = byKey[key];
    return r ? { key: key, code: r.code, cohort_id: r.cohort_id, name: r.name, day: r.day || '' } : null;
  };

  // ⚠ בחירה ידנית מההצעות חייבת לשלוף לפי *מפתח*, לא לחפש את השם שוב: השם
  // הזה בדיוק הוא זה שהיה מעורפל מלכתחילה, וחיפוש חוזר יחזיר שוב «לא הוכרע».
  if (wantKeys) {
    const out = {};
    b.keys.forEach((k) => { const r = byKey[k]; if (r) out[k] = Object.assign({ pending: !!r.pending, name: r.name, day: r.day || '' }, vals(r)); });
    return res.json({ ok: true, columns: MONDAY_COLS, values: out });
  }

  const rows = names.map((raw, i) => {
    const line = String(raw == null ? '' : raw).trim();
    const out = {
      line: i + 1, raw: line, matched: null, suggestions: [],
      values: vals(null), pending: false, ambiguous: false, blank: !line,
    };
    if (!line) return out;
    const m = nameMatch.matchName(line, candidates);
    if (m.exact) {
      out.matched = brief(m.exact.code);
      const r = byKey[m.exact.code];
      out.values = vals(r); out.pending = !!(r && r.pending);
      return out;
    }
    out.suggestions = (m.suggestions || []).map((s) => Object.assign(brief(s.code) || {}, { reason: s.reason, confidence: s.confidence }));
    // אותו שם בשני מחזורים (אותו אדם בשני ימים / כפילות) — לא מכריעים לבד.
    out.ambiguous = out.suggestions.length > 1;
    return out;
  });

  const matchedN = rows.filter((r) => r.matched).length;
  res.json({
    ok: true, columns: MONDAY_COLS, rows: rows,
    total: rows.length,
    blank: rows.filter((r) => r.blank).length,
    matched: matchedN,
    unmatched: rows.filter((r) => !r.blank && !r.matched).length,
    pending: rows.filter((r) => r.pending).length,
    pool: pool.length,
  });
});

// קובץ ייבוא למאנדיי.
// ⚠ למה קובץ ולא הדבקה: אי אפשר להעתיק/להדביק תאים בגריד של מאנדיי.
// הטריק שמונע שורות כפולות — עמודת השם בקובץ היא **הכתיב של הבורד** (מה
// שהמשתמש הדביק), ולא השם שהמועמדת הקלידה בבוקר. כך «Overwrite existing
// items» לפי עמודת השם מוצא כל שורה בדיוק, ואף פריט חדש לא נוצר.
// ובנוסף: נכללות רק שורות שהותאמו — שם שלא נמצא פשוט לא בקובץ.
app.post('/api/examiner/grading/monday-file', authExaminer, (req, res) => {
  const b = req.body || {};
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'אין שורות מותאמות לייצוא.' });
  const withRec = !!b.recommendation;

  const ids = Array.from(new Set(db.prepare('SELECT id FROM grading_cohorts').all().map((c) => c.id)));
  const byKey = {};
  for (const id of ids) buildSheetRows(id).forEach((r) => { byKey[id + ':' + r.code] = r; });

  const oneLine = (s) => String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim();
  const header = ['שם', 'ציון', 'רב-מלל', 'כמותי', 'אנגלית'].concat(withRec ? ['המלצה'] : []);
  const out = [];
  for (const row of rows) {
    const r = byKey[row.key];
    if (!r || r.pending) continue;          // בלי ציון — אין מה לכתוב לבורד
    const name = String(row.board_name || r.name || '').trim();
    if (!name) continue;
    const o = {
      'שם': name,                            // ⚠ הכתיב של הבורד, לא שלנו
      'ציון': r.final != null ? r.final : '',
      'רב-מלל': r.ravMelel != null ? r.ravMelel : '',
      'כמותי': r.quant != null ? r.quant : '',
      'אנגלית': r.english != null ? r.english : '',
    };
    if (withRec) o['המלצה'] = oneLine(r.recommendation);
    out.push(o);
  }
  if (!out.length) return res.status(400).json({ error: 'אין שורות עם ציון לייצוא.' });

  const ws = XLSX.utils.json_to_sheet(out, { header: header });
  ws['!views'] = [{ RTL: true }];
  ws['!cols'] = [{ wch: 24 }, { wch: 8 }, { wch: 9 }, { wch: 8 }, { wch: 9 }].concat(withRec ? [{ wch: 60 }] : []);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ציונים');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  setDownloadName(res, 'monday-scores.xlsx');
  res.send(buf);
});

// ============================================================
//  שליחה ישירה למאנדיי (API)
// ============================================================
// ⚠ `change_multiple_column_values` כותב רק את העמודות שנקבו בשמן. זו הסיבה
// שעברנו לכאן מייבוא Excel — «Overwrite existing items» כותב את הפריט כולו.
// ⚠ הטוקן לא מוחזר בשום תשובה. `has_token` בלבד.

// כל השורות המנוקדות מכל המחזורים, לפי מפתח — בסיס להתאמה ולכתיבה.
// ⚠ `days` הוא רשימת מזהי «<cohort_id>|<יום>». **בלי בחירה מחזיר ריק** ולא
// «הכול» — משתמש ששולח למאנדיי בלי לבחור היה חושף נבחנים שטרם נבדקו.
function mondayPool(days) {
  const want = Array.isArray(days) ? new Set(days.map(String)) : null;
  if (!want || !want.size) return [];
  const ids = db.prepare('SELECT id FROM grading_cohorts ORDER BY id').all().map((c) => c.id);
  const pool = [];
  for (const id of ids) {
    buildSheetRows(id).forEach((r) => {
      const dayKey = id + '|' + (r.day || '');
      if (!want.has(dayKey)) return;
      // ⚠ נבחנת שהוצאה מהגיליון לא נשלחת. זו הדרך לנטרל רשומה כפולה, וללא
      // הסינון הזה היא הייתה ממשיכה להופיע כאן אחרי שהמשתמש הוציא אותה.
      if (!r.include) return;
      pool.push(Object.assign({ cohort_id: id, key: id + ':' + r.code, day_key: dayKey }, r));
    });
  }
  return pool;
}

// הימים שאפשר לשלוח, עם ספירת «נבדקו מתוך». מאותו מקור שמזין את השליחה
// (`buildSheetRows`), כדי שלא יופיעו שני מספרים שונים לאותו יום.
app.get('/api/examiner/monday/days', authExaminer, (req, res) => {
  const out = [];
  const cohorts = db.prepare('SELECT id, name FROM grading_cohorts ORDER BY id DESC').all();
  for (const c of cohorts) {
    const byDay = {};
    buildSheetRows(c.id).forEach((r) => {
      if (!r.include) return;   // אותו סינון כמו mondayPool — אחרת הספירה לא תתאים לנשלח
      const d = r.day || '(ללא יום)';
      if (!byDay[d]) byDay[d] = { total: 0, graded: 0 };
      byDay[d].total++;
      if (!r.pending) byDay[d].graded++;
    });
    Object.keys(byDay).forEach((d) => out.push({
      day_key: c.id + '|' + (d === '(ללא יום)' ? '' : d),
      cohort_id: c.id, cohort_name: c.name, day: d,
      total: byDay[d].total, graded: byDay[d].graded, pending: byDay[d].total - byDay[d].graded,
    }));
  }
  res.json({ ok: true, days: out });
});
const MONDAY_FIELDS = [
  { field: 'final', label: 'ציון' },
  { field: 'ravMelel', label: 'רב-מלל' },
  { field: 'quant', label: 'כמותי' },
  { field: 'english', label: 'אנגלית' },
  { field: 'recommendation', label: 'המלצה' },
];

app.get('/api/examiner/monday/test', authExaminer, async (req, res) => {
  if (!monday.hasToken()) {
    return res.json({ ok: false, has_token: false, message: 'לא הוגדר טוקן של מאנדיי. הוסיפו MONDAY_API_TOKEN בהגדרות השרת.' });
  }
  try {
    const me = await monday.testToken();
    res.json({ ok: true, has_token: true, me: me ? { name: me.name, email: me.email } : null,
      message: me ? ('מחובר כ־' + me.name + '.') : 'הטוקן תקין.' });
  } catch (e) { res.json({ ok: false, has_token: true, message: e.message }); }
});

app.get('/api/examiner/monday/boards', authExaminer, async (req, res) => {
  try { res.json({ ok: true, boards: await monday.listBoards() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/examiner/monday/board/:id', authExaminer, async (req, res) => {
  try {
    const info = await monday.boardColumns(req.params.id);
    // רק סוגים שאנחנו יודעים לכתוב אליהם בבטחה
    const writable = info.columns.filter((c) => ['numbers', 'text', 'long_text'].indexOf(c.type) >= 0);
    res.json({ ok: true, board: { id: info.id, name: info.name }, columns: writable, fields: MONDAY_FIELDS });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// תצוגה מקדימה — **קריאה בלבד**. שולף את שמות הפריטים מהבורד, מתאים אותם
// מול הציונים, ומחזיר בדיוק מה ייכתב. שום דבר לא נכתב כאן.
app.post('/api/examiner/monday/preview', authExaminer, async (req, res) => {
  const b = req.body || {};
  if (!b.board_id) return res.status(400).json({ error: 'לא נבחר בורד.' });
  if (!Array.isArray(b.days) || !b.days.length) return res.status(400).json({ error: 'בחרו לפחות יום אחד לשליחה.' });
  try {
    const items = await monday.boardItems(b.board_id);
    const pool = mondayPool(b.days);
    if (!pool.length) return res.status(400).json({ error: 'לא נמצאו נבחנים בימים שנבחרו.' });
    const candidates = pool.map((r) => ({ code: r.key, name: r.name }));
    const byKey = {}; pool.forEach((r) => { byKey[r.key] = r; });
    const vals = (r) => ({ final: r.final, ravMelel: r.ravMelel, quant: r.quant, english: r.english,
      recommendation: String(r.recommendation || '').replace(/[\t\r\n]+/g, ' ').trim() });

    const rows = items.map((it) => {
      const m = nameMatch.matchName(it.name, candidates);
      const r = m.exact ? byKey[m.exact.code] : null;
      const out = {
        item_id: it.id, board_name: it.name,
        matched: r ? { key: r.key, name: r.name, day: r.day || '' } : null,
        suggestions: m.exact ? [] : (m.suggestions || []).map((s) => ({
          key: s.code, name: (byKey[s.code] || {}).name, day: (byKey[s.code] || {}).day || '',
          reason: s.reason, confidence: s.confidence,
        })),
        pending: !!(r && r.pending), values: r && !r.pending ? vals(r) : {},
      };
      return out;
    });
    // ★ הפול המלא חוזר ללקוח כדי ששיבוץ ידני ייפתר **בזיכרון** ולא בקריאה
    // חוזרת לשרת. בלי זה כל שיבוץ מושך את כל הבורד מחדש.
    res.json({ ok: true, fields: MONDAY_FIELDS, rows: rows,
      pool: pool.map((r) => ({ key: r.key, name: r.name, day: r.day || '', code: r.code,
        pending: !!r.pending, values: r.pending ? {} : vals(r) })),
      total: rows.length,
      will_write: rows.filter((r) => r.matched && !r.pending).length,
      unmatched: rows.filter((r) => !r.matched).length,
      pending: rows.filter((r) => r.pending).length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// הכתיבה בפועל. רק שורות שהמשתמש ראה בתצוגה המקדימה, ורק העמודות שמופו.
app.post('/api/examiner/monday/push', authExaminer, async (req, res) => {
  const b = req.body || {};
  const boardId = b.board_id;
  const mapping = b.mapping || {};     // { field: column_id }
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!boardId) return res.status(400).json({ error: 'לא נבחר בורד.' });
  if (!rows.length) return res.status(400).json({ error: 'אין שורות לשליחה.' });
  const mapped = Object.keys(mapping).filter((f) => mapping[f]);
  if (!mapped.length) return res.status(400).json({ error: 'לא מופתה אף עמודה.' });

  let colTypes = {};
  try {
    const info = await monday.boardColumns(boardId);
    info.columns.forEach((c) => { colTypes[c.id] = c.type; });
  } catch (e) { return res.status(400).json({ error: e.message }); }

  // ⚠ אותה הגבלת ימים כמו בתצוגה המקדימה. מפתח מיום שלא נבחר לא יימצא בפול
  // ולכן פשוט ידולג — הגנה מפני שליחה של נבחנים שהמשתמש לא התכוון אליהם.
  if (!Array.isArray(b.days) || !b.days.length) return res.status(400).json({ error: 'בחרו לפחות יום אחד לשליחה.' });
  const pool = mondayPool(b.days);
  const byKey = {}; pool.forEach((r) => { byKey[r.key] = r; });

  const results = { written: 0, skipped: 0, failed: [] };
  for (const row of rows) {
    const r = byKey[row.key];
    if (!r || r.pending) { results.skipped++; continue; }
    const vals = {};
    for (const f of mapped) {
      const colId = mapping[f];
      const raw = (f === 'recommendation')
        ? String(r.recommendation || '').replace(/[\t\r\n]+/g, ' ').trim()
        : r[f];
      // ⚠ ערך ריק לא נשלח בכלל — שליחה של "" הייתה *מוחקת* תא קיים בבורד.
      if (raw == null || raw === '') continue;
      vals[colId] = monday.columnValue(colTypes[colId] || 'text', raw);
    }
    if (!Object.keys(vals).length) { results.skipped++; continue; }
    try {
      await monday.setValues(boardId, row.item_id, vals);
      results.written++;
    } catch (e) {
      results.failed.push({ item_id: row.item_id, name: row.board_name || r.name, error: e.message });
      // כשל אימות/הרשאה יחזור על עצמו בכל שורה — עוצרים במקום להציף
      if (/טוקן|הרשאה/.test(e.message)) break;
    }
  }
  logEvent(null, 'monday_push', 'board ' + boardId + ' · נכתבו ' + results.written + ' · נכשלו ' + results.failed.length);
  res.json(Object.assign({ ok: true }, results));
});

app.get('/api/examiner/grading/export-sheet/:id', authExaminer, (req, res) => {
  const id = Number(req.params.id);
  const cohort = db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(id);
  if (!cohort) return res.status(404).json({ error: 'מחזור לא נמצא.' });
  const all = req.query.all === '1';
  const rows = sortSheetRows(buildSheetRows(id).filter((r) => all || r.include), req.query.sort);
  const buf = writeSheetBook([{ title: 'ציונים', rows: rows }]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  setDownloadName(res, 'grades-' + id + '.xlsx');
  res.send(buf);
});

// גיליון מאוחד לכמה ימים: גיליון לכל יום + גיליון «הכול» עם עמודת יום.
// הדירוג והאחוזון נשארים *בתוך* כל יום — המבחנים לא זהים בין הימים.
app.get('/api/examiner/grading/export-merged', authExaminer, (req, res) => {
  const ids = String(req.query.cohorts || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'לא נבחרו מחזורים.' });
  const all = req.query.all === '1';
  const sheets = [], everything = [];
  for (const id of ids) {
    const cohort = db.prepare('SELECT * FROM grading_cohorts WHERE id=?').get(id);
    if (!cohort) continue;
    const rows = sortSheetRows(buildSheetRows(id).filter((r) => all || r.include), req.query.sort);
    sheets.push({ title: (cohort.day_label || cohort.name || ('מחזור ' + id)), rows: rows });
    everything.push.apply(everything, rows);
  }
  if (!sheets.length) return res.status(404).json({ error: 'לא נמצאו מחזורים.' });
  if (req.query.sort === 'name') everything.sort((a, b) => nameMatch.normBasic(a.name).localeCompare(nameMatch.normBasic(b.name), 'he'));
  else everything.sort((a, b) => (b.final || 0) - (a.final || 0));
  const buf = writeSheetBook([{ title: 'הכול', rows: everything }].concat(sheets));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  setDownloadName(res, 'grades-merged.xlsx');
  res.send(buf);
});

app.post('/api/examiner/grading/delete-cohort', authExaminer, (req, res) => {
  const id = Number(req.body && req.body.cohort_id);
  if (!id) return res.status(400).json({ error: 'חסר מזהה.' });
  ['grading_rollups', 'grading_items', 'grading_answers', 'grading_examinees', 'grading_audit'].forEach((t) => db.prepare('DELETE FROM ' + t + ' WHERE cohort_id=?').run(id));
  db.prepare('DELETE FROM grading_cohorts WHERE id=?').run(id);
  delete gradingJobs[id];
  res.json({ ok: true });
});

// ============================================================
//  קבצים סטטיים
// ============================================================
// מונעים מהדפדפן לשמור גרסה ישנה של הקוד (HTML/JS/CSS) — כך עדכון תמיד נכנס לתוקף מיד.
app.use(function (req, res, next) {
  if (/\.(html|js|css)$/i.test(req.path) || req.path === '/' || req.path === '/examiner' || req.path === '/grade' || req.path === '/interviewer') {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }
  next();
});
app.use('/vendor/katex', express.static(path.join(__dirname, 'node_modules', 'katex', 'dist')));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- בוחן ההוראה למועמדים ----------
// מודול נפרד לגמרי: טבלאות משלו, כניסה משלו, ואפס נגיעה במנוע הסבבים.
require('./lib/teachRoutes').register(app, { db, now, newToken, authExaminer });

app.get('/examiner', (req, res) => res.sendFile(path.join(__dirname, 'public', 'examiner.html')));
app.get('/grade', (req, res) => res.sendFile(path.join(__dirname, 'public', 'grade.html')));
app.get('/interviewer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'interviewer.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// מטפל שגיאות גלובלי — כדי שתקלה לא תחזיר stack trace ונתיבי קבצים ללקוח
app.use((err, req, res, next) => {
  console.error('שגיאת שרת ב-' + req.method + ' ' + req.path + ':', err && err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'שגיאת שרת. נסו שוב — ואם זה חוזר, צלמו מסך ופנו לתמיכה.' });
});

// בדיקת בריאות (ל-Render)
app.get('/healthz', (req, res) => res.json({ ok: true, subjects: content.listSubjects().length }));

app.listen(PORT, () => {
  const problems = content.getProblems().filter((p) => p.level === 'error');
  console.log(`\n  מערכת יום הערכה פועלת:  http://localhost:${PORT}`);
  console.log(`  מסך המנהל:              כפתור "כניסת מנהל" בפינה, או ${'http://localhost:' + PORT}/examiner`);
  console.log(`  מקצועות זמינים:         ${content.listSubjects().join(', ')}`);
  if (problems.length) console.log(`  ⚠ ${problems.length} בעיות תוכן (הרץ: npm run check-content)`);
  // גיבוי אוטומטי — מיד עם העלייה ואז כל BACKUP_INTERVAL_MIN דקות
  makeBackup('startup');
  setInterval(() => makeBackup('auto'), BACKUP_INTERVAL_MIN * 60 * 1000);
  console.log(`  גיבוי אוטומטי:          כל ${BACKUP_INTERVAL_MIN} דק' → ${BACKUP_DIR}`);
  console.log('');
});
