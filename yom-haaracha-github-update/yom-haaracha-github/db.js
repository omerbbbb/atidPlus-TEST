'use strict';
/*
 * שכבת בסיס הנתונים.
 * משתמשים ב-node:sqlite המובנה ב-Node (מגרסה 22.5+, ללא צורך בהתקנה חיצונית).
 * קובץ יחיד בתיקיית data/ — פשוט, אמין, וקל לגיבוי (מעתיקים את הקובץ).
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'assessment.db');
const db = new DatabaseSync(DB_PATH);

// WAL = כתיבה עמידה יותר לקריסות ולכתיבות מקבילות (40 נבחנים ששומרים בו-זמנית).
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS examinees (
  code           TEXT PRIMARY KEY,        -- הקוד האישי (משמש לשחזור)
  name           TEXT NOT NULL,
  token          TEXT NOT NULL,           -- אסימון הפעלה (session)
  declaration    TEXT,                    -- שאלון ההצהרה (JSON)
  subjects       TEXT,                    -- המקצועות שנבחרו (JSON)
  math_level     TEXT,                    -- "5"/"4"/"3" או null
  interview_round INTEGER,                -- (לא בשימוש במודל החי; נשמר לתאימות)
  interviewed    INTEGER NOT NULL DEFAULT 0,  -- האם כבר התראיין (דגל)
  in_interview   INTEGER NOT NULL DEFAULT 0,  -- כרגע בריאיון (טיימר הפרק מושהה)
  created_at     INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'registered'  -- registered | active | left
);

CREATE TABLE IF NOT EXISTS slots (
  code            TEXT NOT NULL,
  round           INTEGER NOT NULL,       -- 1..5
  kind            TEXT NOT NULL,          -- 'chapter' | 'interview'
  subject         TEXT,
  level           TEXT,
  chapter_id      TEXT,
  variant_index   INTEGER DEFAULT 0,      -- איזה וריאנט של הפרק (0 = מקורי)
  started_at      INTEGER,                -- חותמת שרת (ms) לתחילת הטיימר
  duration_sec    INTEGER NOT NULL DEFAULT 1200,   -- 20:00
  paused          INTEGER NOT NULL DEFAULT 0,
  paused_at       INTEGER,
  paused_accum_sec INTEGER NOT NULL DEFAULT 0,
  not_comfortable INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | active | done
  PRIMARY KEY (code, round),
  FOREIGN KEY (code) REFERENCES examinees(code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS answers (
  code          TEXT NOT NULL,
  round         INTEGER NOT NULL,
  chapter_id    TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  type          TEXT,
  answer        TEXT,                     -- טקסט חופשי או מזהה אפשרות נבחרת
  started_at    INTEGER,
  updated_at    INTEGER,
  time_spent_sec INTEGER DEFAULT 0,
  dont_know     INTEGER NOT NULL DEFAULT 0,  -- הנבחן/ת סימן/ה "לא יודע/ת" על הפריט
  PRIMARY KEY (code, chapter_id, item_id),
  FOREIGN KEY (code) REFERENCES examinees(code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rounds (
  round        INTEGER PRIMARY KEY,       -- 1..5
  code         TEXT,                      -- קוד הסבב (סיסמה) שהבוחן מכריז
  released     INTEGER NOT NULL DEFAULT 0,
  released_at  INTEGER,
  state        TEXT NOT NULL DEFAULT 'planned',  -- planned | running | ended
  started_at   INTEGER
);

-- מי מסומן לריאיון בכל סבב (המנהל קובע, מראש או חי)
CREATE TABLE IF NOT EXISTS interview_marks (
  round  INTEGER NOT NULL,
  code   TEXT NOT NULL,
  PRIMARY KEY (round, code),
  FOREIGN KEY (code) REFERENCES examinees(code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  code   TEXT,
  type   TEXT NOT NULL,                   -- blur | tabhide | paste_blocked | login | ...
  detail TEXT,
  at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// מיגרציה עדינה לבסיסי נתונים קיימים (בשרת) — הוספת עמודות חדשות אם חסרות.
for (const alter of [
  "ALTER TABLE rounds ADD COLUMN state TEXT NOT NULL DEFAULT 'planned'",
  'ALTER TABLE rounds ADD COLUMN started_at INTEGER',
  'ALTER TABLE examinees ADD COLUMN interviewed INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE examinees ADD COLUMN in_interview INTEGER NOT NULL DEFAULT 0',
  // «קוד אישי» חופשי שהנבחן בוחר (לא ייחודי). המזהה הפנימי הקבוע נשאר בעמודת code.
  'ALTER TABLE examinees ADD COLUMN pin TEXT',
  // סימון "לא יודע/ת" פר-פריט (כפתור חדש במסך הנבחן).
  'ALTER TABLE answers ADD COLUMN dont_know INTEGER NOT NULL DEFAULT 0',
  // שיוך נבחן ליום הערכה (הפרדה בין ימים).
  'ALTER TABLE examinees ADD COLUMN day_id INTEGER',
  // בריף קצר על הנבחן, למראיין שלו.
  'ALTER TABLE examinees ADD COLUMN interview_brief TEXT',
  // האם השם נוצר בהרשמה עצמית בלי התאמה לרשימה שהמנהל הזין (דגל לבדיקה).
  'ALTER TABLE examinees ADD COLUMN self_registered INTEGER NOT NULL DEFAULT 0',
  // מי מראיין את הנבחן בסבב הזה (מראיין = חדר קבוע).
  'ALTER TABLE interview_marks ADD COLUMN interviewer_id INTEGER',
]) {
  try { db.exec(alter); } catch (e) { /* העמודה כבר קיימת */ }
}
// מילוי אחורה: לנבחנים ישנים ה«קוד האישי» הוא הקוד שאיתו נרשמו (המזהה הפנימי).
try { db.exec("UPDATE examinees SET pin = code WHERE pin IS NULL OR pin = ''"); } catch (e) {}

// ---------- ימי הערכה (הפרדה בין ימים) ----------
// כל נבחן משויך ל«יום הערכה». מכיוון שכל התשובות/המשבצות/הריאיונות תלויים
// במזהה הפנימי של הנבחן (code), די לשייך את הנבחן ליום — וכל השאר נפרד מעצמו.
// מצב הסבבים הוא פר-יום (day_rounds), וכך גם המראיינים.
db.exec(`
CREATE TABLE IF NOT EXISTS days (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,                      -- שם היום (למשל "יום הערכה 4.8.26")
  title        TEXT,                               -- כותרת שמוצגת לנבחן בדף הכניסה
  total_rounds INTEGER NOT NULL DEFAULT 5,         -- 3..5
  phase        TEXT NOT NULL DEFAULT 'registration', -- registration | open | running
  status       TEXT NOT NULL DEFAULT 'open',       -- open | closed
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS day_rounds (
  day_id       INTEGER NOT NULL,
  round        INTEGER NOT NULL,
  code         TEXT,
  released     INTEGER NOT NULL DEFAULT 0,
  released_at  INTEGER,
  state        TEXT NOT NULL DEFAULT 'planned',    -- planned | running | ended
  started_at   INTEGER,
  PRIMARY KEY (day_id, round)
);

-- מראיין = חדר קבוע ליום. הנבחן רואה את השם והחדר בזמן הריאיון.
CREATE TABLE IF NOT EXISTS interviewers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id     INTEGER NOT NULL,
  name       TEXT NOT NULL,
  room       TEXT,
  brief      TEXT,                                 -- הנחיות למראיין עצמו (אופציונלי)
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- בריפים שהודבקו ולא נמצאה להם התאמת שם — נשמרים כדי שאפשר יהיה לשייך ידנית.
CREATE TABLE IF NOT EXISTS pending_briefs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id     INTEGER NOT NULL,
  raw_name   TEXT NOT NULL,      -- השם כפי שהודבק
  brief      TEXT,
  created_at INTEGER NOT NULL
);

-- בקשות החלפה בלו"ז הריאיונות: המראיין מבקש, המנהל מאשר (ואז מבוצע בפועל).
CREATE TABLE IF NOT EXISTS interview_swap_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id           INTEGER NOT NULL,
  interviewer_id   INTEGER,
  code             TEXT,                           -- הנבחן שהבקשה נוגעת לו (אופציונלי)
  round            INTEGER,
  requested_change TEXT,                           -- טקסט חופשי של הבקשה
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at       INTEGER NOT NULL,
  decided_at       INTEGER
);
`);

// ---------- מערכת הבדיקה («מסך בדיקה») ----------
// מנותקת מהנתונים החיים: בעת "צלם מצב לבדיקה" מעתיקים עותק קפוא לטבלאות grading_*.
// אין FOREIGN KEY לנבחנים — הבדיקה שורדת גם אם הנבחנים החיים נמחקים/מתאפסים,
// ונשמרת לאורך כל תקופת המיונים.
db.exec(`
CREATE TABLE IF NOT EXISTS grading_cohorts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,               -- שם המחזור (למשל "יום הערכה 3.8.26")
  created_at   INTEGER NOT NULL,
  source_hash  TEXT,                        -- טביעת-אצבע של המקור (למניעת snapshot כפול)
  status       TEXT NOT NULL DEFAULT 'open',-- open | finalized
  weights_json TEXT                         -- הקבועים של מנוע הניקוד בזמן ה-snapshot
);

CREATE TABLE IF NOT EXISTS grading_examinees (
  cohort_id        INTEGER NOT NULL,
  code             TEXT NOT NULL,           -- המזהה הפנימי מהמערכת החיה (עותק)
  name             TEXT NOT NULL,
  subjects         TEXT,                    -- JSON
  math_level       TEXT,
  declaration      TEXT,                    -- JSON
  locked           INTEGER NOT NULL DEFAULT 0,  -- ננעל = ציון סופי אושר
  reviewer         TEXT,
  include_in_sheet INTEGER NOT NULL DEFAULT 1,  -- האם נכלל בגיליון הציונים
  note             TEXT,                    -- הערת בודק כללית לנבחן
  partial          INTEGER NOT NULL DEFAULT 0,  -- מבחן חלקי / עזב
  PRIMARY KEY (cohort_id, code)
);

CREATE TABLE IF NOT EXISTS grading_answers (
  cohort_id  INTEGER NOT NULL,
  code       TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  type       TEXT,
  answer     TEXT,
  correct    INTEGER,                       -- רב-ברירה: 1/0/NULL (קפוא מהמפתח)
  dont_know  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cohort_id, code, chapter_id, item_id)
);

CREATE TABLE IF NOT EXISTS grading_items (
  cohort_id      INTEGER NOT NULL,
  code           TEXT NOT NULL,
  chapter_id     TEXT NOT NULL,
  item_id        TEXT NOT NULL,
  ai_scores_json TEXT,                       -- {accuracy,depth,diagnosis_fit,clarity}
  ai_conclusion  TEXT,
  ai_attention   TEXT,
  ai_confidence  TEXT,
  ai_status      TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
  human_scores_json TEXT,                    -- ציונים אחרי עריכה (אם נגעו)
  human_note     TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | edited
  PRIMARY KEY (cohort_id, code, chapter_id, item_id)
);

CREATE TABLE IF NOT EXISTS grading_rollups (
  cohort_id        INTEGER NOT NULL,
  code             TEXT NOT NULL,
  domain_scores_json TEXT,
  content_c        REAL,
  teaching_t       REAL,
  final_1to5       REAL,
  breadth_bonus    REAL,
  top_domain       TEXT,
  rank             INTEGER,
  percentile       INTEGER,
  recommendation   TEXT,
  PRIMARY KEY (cohort_id, code)
);

CREATE TABLE IF NOT EXISTS grading_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cohort_id  INTEGER NOT NULL,
  code       TEXT,
  chapter_id TEXT,
  item_id    TEXT,
  field      TEXT,
  old        TEXT,
  new        TEXT,
  by         TEXT,
  at         INTEGER NOT NULL
);
`);

// ============================================================================
//  בוחן ההוראה — מועמדים להוראה
//  נפרד לחלוטין מיום ההערכה: טבלאות משלו, כניסה משלה וגיליון משלו.
//  ⚠ במכוון אין כאן day_id ואין round — מועמד נבחן מתי שנוח לו, לבדו.
// ============================================================================
db.exec(`
CREATE TABLE IF NOT EXISTS teach_candidates (
  code             TEXT PRIMARY KEY,           -- מזהה פנימי
  name             TEXT NOT NULL,
  pin              TEXT NOT NULL,              -- הסיסמה שהמועמד בחר בכניסה הראשונה
  phone            TEXT NOT NULL,
  token            TEXT,                       -- אסימון session
  subject_id       TEXT,                       -- המקצוע שנבחר (math5 / history / ...)
  status           TEXT NOT NULL DEFAULT 'registered', -- registered | running | submitted
  started_at       INTEGER,                    -- מתי נלחץ «התחל» (שעון השרת)
  finished_at      INTEGER,
  duration_sec     INTEGER NOT NULL DEFAULT 1500,
  paused           INTEGER NOT NULL DEFAULT 0, -- המנהל עצר את השעון
  paused_at        INTEGER,
  paused_accum_sec INTEGER NOT NULL DEFAULT 0,
  extra_sec        INTEGER NOT NULL DEFAULT 0, -- תוספת זמן שהמנהל העניק
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teach_answers (
  code           TEXT NOT NULL,
  qid            TEXT NOT NULL,               -- q1 / q2 / q3 / q4 / q5 / q6
  value          TEXT,                        -- JSON: התשובה על כל חלקיה
  started_at     INTEGER,                     -- מתי המסך הזה נפתח לראשונה
  updated_at     INTEGER,
  time_spent_sec INTEGER NOT NULL DEFAULT 0,  -- כמה זמן הוא באמת בילה בשאלה
  PRIMARY KEY (code, qid),
  FOREIGN KEY (code) REFERENCES teach_candidates(code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS teach_grades (
  code        TEXT NOT NULL,
  qid         TEXT NOT NULL,
  scores_json TEXT,                           -- הציונים לפי הרוּבּריקה
  comment     TEXT,                           -- נימוק הבודק (AI או אדם)
  demo        INTEGER NOT NULL DEFAULT 0,     -- ⚠ ציון הדגמה: רץ בלי מפתח API
  graded_at   INTEGER,
  PRIMARY KEY (code, qid)
);

CREATE TABLE IF NOT EXISTS teach_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  code   TEXT,
  kind   TEXT NOT NULL,                       -- login | start | question | submit | admin
  detail TEXT,
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teach_events_code ON teach_events(code, at);
`);

// מיגרציה שנייה — עמודות על טבלאות שנוצרות למעלה (days / grading_cohorts).
// ⚠ חייבת לרוץ *אחרי* יצירתן, אחרת ה-ALTER נכשל בשקט והעמודה לא נוספת.
for (const alter of [
  // ⚠ «מצב בדיקה»: המנהל עובר על המבחן בעצמו כדי לאתר טעויות תוכן.
  //   השעון קפוא, אין הגשה אוטומטית, והמועמד לא נספר כמועמד אמיתי.
  'ALTER TABLE teach_candidates ADD COLUMN review INTEGER NOT NULL DEFAULT 0',
  // «המבחן הסתיים» הוא מצב של *יום* מסוים, לא של המערכת כולה.
  'ALTER TABLE days ADD COLUMN exam_ended INTEGER NOT NULL DEFAULT 0',
  // ההודעה שהנבחן רואה במסך הסיום — המנהל עורך אותה בעצמו.
  'ALTER TABLE days ADD COLUMN finish_message TEXT',
  // צילום לבדיקה: מאיזה יום הוא בא, והאם הוא הצילום הראשי של אותו יום.
  'ALTER TABLE grading_cohorts ADD COLUMN day_id INTEGER',
  'ALTER TABLE grading_cohorts ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0',
  // תווית יום לגיליון המאוחד — למחזור שיובא מקובץ ואין לו day_id חי.
  'ALTER TABLE grading_cohorts ADD COLUMN day_label TEXT',
  // מודל הניקוד: הבונוס על המקצוע, פרופיל 4 הקריטריונים, וציון לכל מקצוע.
  'ALTER TABLE grading_rollups ADD COLUMN bonus REAL',
  'ALTER TABLE grading_rollups ADD COLUMN bonus_from TEXT',
  'ALTER TABLE grading_rollups ADD COLUMN criteria_json TEXT',
  'ALTER TABLE grading_rollups ADD COLUMN subjects_json TEXT',
  // ⚠ ציון ידני שדורס את המחושב. נדרש כשאותה נבחנת נרשמה פעמיים (חלק מהפרקים
  // תחת שם אחד וחלק תחת שם אחר) — אז *שני* הציונים המחושבים שגויים, כי כל אחד
  // מבוסס על נתונים חלקיים, ורק אדם יכול להכריע מה הציון הנכון.
  'ALTER TABLE grading_examinees ADD COLUMN manual_scores_json TEXT',
  // שעון הסבב — מקור אמת אחד לשלושת המסכים (מנהל · מראיין · נבחן שהגיש).
  // `started_at` כבר קיים בטבלה; חסרו המשך וההשהיה, במקביל למה שיש ב-slots.
  'ALTER TABLE day_rounds ADD COLUMN duration_sec INTEGER',
  'ALTER TABLE day_rounds ADD COLUMN paused INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE day_rounds ADD COLUMN paused_at INTEGER',
  'ALTER TABLE day_rounds ADD COLUMN paused_accum_sec INTEGER NOT NULL DEFAULT 0',
  // ⚠ סימון «הציון הזה הוא הדגמה» — נכתב כשרצה בדיקה בלי ANTHROPIC_API_KEY.
  // בלעדיו ציוני הדגמה (לפי אורך התשובה בלבד) נראים במסד זהים לציונים אמיתיים,
  // ואי אפשר לבדוק אותם מחדש אחרי שמוסיפים מפתח.
  'ALTER TABLE grading_items ADD COLUMN ai_demo INTEGER NOT NULL DEFAULT 0',
]) {
  try { db.exec(alter); } catch (e) { /* העמודה כבר קיימת */ }
}

// אתחול 5 סבבים אם עדיין לא קיימים (טבלת rounds הישנה — נשמרת לתאימות ולמיגרציה).
const roundCount = db.prepare('SELECT COUNT(*) AS c FROM rounds').get().c;
if (roundCount === 0) {
  const insRound = db.prepare('INSERT INTO rounds (round, code, released) VALUES (?, ?, 0)');
  for (let r = 1; r <= 5; r++) insRound.run(r, 'round' + r);
}

/* ---------- מיגרציה ליום-הערכה (אידמפוטנטית, לא מוחקת דבר) ----------
 * אם אין עדיין ימים: יוצרים יום אחד. אם כבר יש נבחנים בבסיס הנתונים — הם
 * שייכים ליום שכבר התקיים, ולכן היום נקרא «יום הערכה קודם» ומצב הסבבים שלו
 * מועתק מטבלת rounds הישנה. אם אין נבחנים — זה התקנה חדשה/יום ראשון.
 * בכל מקרה נקבע active_day_id, כך שההתנהגות זהה לקודם — רק עם הפרדה.
 */
function seedDayRounds(dayId, n, copyFromLegacy) {
  const legacy = copyFromLegacy
    ? db.prepare('SELECT round, code, released, released_at, state, started_at FROM rounds ORDER BY round').all()
    : [];
  const byRound = {};
  for (const r of legacy) byRound[r.round] = r;
  const ins = db.prepare(
    'INSERT OR IGNORE INTO day_rounds (day_id, round, code, released, released_at, state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const maxRound = Math.max(n, legacy.length ? Math.max(...legacy.map((r) => r.round)) : 0);
  for (let r = 1; r <= maxRound; r++) {
    const src = byRound[r];
    ins.run(dayId, r, src ? src.code : 'round' + r, src ? src.released : 0,
      src ? src.released_at : null, src ? src.state : 'planned', src ? src.started_at : null);
  }
}

const dayCount = db.prepare('SELECT COUNT(*) AS c FROM days').get().c;
if (dayCount === 0) {
  const existingExaminees = db.prepare('SELECT COUNT(*) AS c FROM examinees').get().c;
  const hasHistory = existingExaminees > 0;
  const name = hasHistory ? 'יום הערכה קודם' : 'יום הערכה תשפ״ז';
  // אם ליום הקודם היו סבבים שרצו — נשמור את המספר האמיתי שלהם.
  const legacyMax = db.prepare("SELECT MAX(round) AS r FROM rounds WHERE state != 'planned'").get();
  const totalRounds = hasHistory && legacyMax && legacyMax.r ? Math.max(3, Math.min(5, legacyMax.r)) : 5;
  const info = db.prepare(
    'INSERT INTO days (name, title, total_rounds, phase, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, 'יום הערכה תשפ״ז', totalRounds, hasHistory ? 'running' : 'registration', 'open', Date.now());
  const dayId = Number(info.lastInsertRowid);
  seedDayRounds(dayId, totalRounds, hasHistory);
  if (hasHistory) db.prepare('UPDATE examinees SET day_id = ? WHERE day_id IS NULL').run(dayId);
  db.prepare("INSERT INTO config (key, value) VALUES ('active_day_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(dayId));
}
// רשת ביטחון: נבחנים ללא יום (למשל אם נוספו בגרסה ישנה) משויכים ליום הפעיל.
try {
  const active = db.prepare("SELECT value FROM config WHERE key = 'active_day_id'").get();
  if (active && active.value) {
    const aid = Number(active.value);
    db.prepare('UPDATE examinees SET day_id = ? WHERE day_id IS NULL').run(aid);
    // מיגרציה חד-פעמית: «המבחן הסתיים» היה מצב גלובלי — מעבירים ליום הפעיל.
    const migrated = db.prepare("SELECT value FROM config WHERE key = 'exam_ended_migrated'").get();
    if (!migrated) {
      const globalEnded = db.prepare("SELECT value FROM config WHERE key = 'exam_ended'").get();
      if (globalEnded && globalEnded.value === '1') {
        db.prepare('UPDATE days SET exam_ended = 1 WHERE id = ?').run(aid);
      }
      db.prepare("INSERT INTO config (key, value) VALUES ('exam_ended_migrated', '1') ON CONFLICT(key) DO NOTHING").run();
    }
    // צילומי בדיקה קיימים שאין להם יום — משויכים ליום הפעיל (היו נוצרים ממנו).
    db.prepare('UPDATE grading_cohorts SET day_id = ? WHERE day_id IS NULL').run(aid);
  }
} catch (e) { /* לא קריטי */ }

module.exports = { db, DB_PATH, seedDayRounds };
