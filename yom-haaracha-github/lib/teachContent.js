// ============================================================================
//  בוחן ההוראה — טעינת בנק השאלות והרכבת המבחן
//
//  הרעיון: שאלת הבגרות (q1) מתחלפת לפי המקצוע. חמש השאלות שאחריה נכתבות
//  פעם אחת ב-_shared.json ומשרתות כל מקצוע שיתווסף. מקצוע חדש = קובץ אחד.
//
//  ⚠ buildForCandidate מחזיר את המבחן *בלי* התשובות הנכונות. כל מה שנועד
//    לבודק — broken_step, accepts, key_fix, verdict — נשאר כאן בשרת.
// ============================================================================
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'content', 'teach');

let cache = null;

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
}

function load() {
  if (cache) return cache;
  const shared = readJson('_shared.json');
  const subjects = fs.readdirSync(DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => readJson(f))
    .sort((a, b) => (a.order || 99) - (b.order || 99));
  cache = { shared, subjects };
  return cache;
}

function reload() { cache = null; return load(); }

function listSubjects() {
  return load().subjects.map(s => ({ id: s.subject_id, name: s.name, topic: s.topic, exam: s.exam, aids: s.aids || '' }));
}

function getSubject(id) {
  return load().subjects.find(s => s.subject_id === id) || null;
}

function instructions() { return load().shared.instructions || null; }

function durationSec() {
  return Number(load().shared.duration_sec) || 1500;
}

// ---------------------------------------------------------------------------
// השיחה: העץ משותף, ורק מהלך «בוא נבדוק» מדבר בשפת המקצוע.
// ---------------------------------------------------------------------------
function buildSim(shared, subj, keepScores) {
  const sim = JSON.parse(JSON.stringify(shared.sim));
  for (const o of sim.t2.open.opts) {
    if (o.label === '__CHECK__') {
      o.label = subj.check;
      o.reply = subj.check_reply;
    }
  }
  // ⚠ הניקוד של כל מהלך נשאר בשרת — המועמד לא רואה אותו
  if (!keepScores) {
    delete sim.scoring;
    const strip = node => node.opts.forEach(o => { delete o.score; });
    strip(sim.t1);
    Object.values(sim.t2).forEach(strip);
    Object.values(sim.t3).forEach(strip);
  }
  return sim;
}

// ---------------------------------------------------------------------------
// המבחן כפי שהמועמד רואה אותו — בלי שום תשובה נכונה.
// ---------------------------------------------------------------------------
function buildForCandidate(subjectId) {
  const { shared } = load();
  const subj = getSubject(subjectId);
  if (!subj) return null;

  const q1 = subj.q1;
  const questions = [
    {
      id: 'q1', part: 'חלק א · ידע ואבחון', label: 'שאלה 1', type: 'steps',
      stem: 'שאלת בגרות, ' + subj.exam + '. תלמיד הגיש את התשובה המלאה הזו — יש בה שגיאה אחת.',
      brief_he: q1.brief_he, brief_kind: q1.brief_kind, brief_label: q1.brief_label,
      brief_body: q1.brief_body, brief_ltr: !!q1.brief_ltr,
      steps_label: q1.steps_label, steps: q1.steps, steps_ltr: !!q1.steps_ltr,
      ask: 'סמן את השלב שבו התשובה נשברת, וכתוב מה היה צריך להיכתב שם.',
      ans_type: q1.ans_type, ans_label: q1.ans_label, ans_note: q1.ans_note,
      hint: q1.hint
    },
    Object.assign({}, shared.q2, { steps: q1.steps, steps_ltr: !!q1.steps_ltr }),
    {
      id: 'q3', part: 'חלק ב · כיול לתלמיד', label: 'שאלה 3', type: 'text',
      stem: 'ביקשנו מ-AI לכתוב לתלמידה הזו הסבר. ההסבר נכון לחלוטין.',
      profile: subj.q3.profile, ai: subj.q3.ai, ai_ltr: !!subj.q3.ai_ltr,
      ask: shared.q3_ask, hint: shared.q3_hint, cap: shared.q3_cap, rec: shared.q3_rec
    },
    {
      id: 'q4', part: 'חלק ג · בניית שיעור', label: 'שאלה 4', type: 'plans',
      stem: subj.q4.stem,
      plans: subj.q4.plans.map(p => ({ id: p.id, name: p.name, beats: p.beats })),
      ask: shared.q4_ask, hint: shared.q4_hint, cap: shared.q4_cap, rec: shared.q4_rec
    },
    Object.assign({}, buildSim(shared, subj), { id: 'q5' }),
    {
      id: 'q6', part: 'חלק ה · שיקול דעת', label: 'שאלה 6', type: 'mcjust',
      stem: subj.q6.stem,
      opts: subj.q6.opts.map(o => ({ id: o.id, text: o.text })),   // ⚠ בלי verdict
      ask: shared.q6_ask, hint: shared.q6_hint, cap: shared.q6_cap, rec: shared.q6_rec
    }
  ];

  return {
    subject_id: subj.subject_id, subject_name: subj.name,
    exam: subj.exam, topic: subj.topic,
    duration_sec: durationSec(),
    questions
  };
}

// ---------------------------------------------------------------------------
// מפתח הבדיקה — לשרת ולמסך הבודק בלבד.
// ---------------------------------------------------------------------------
function keyFor(subjectId) {
  const { shared } = load();
  const s = getSubject(subjectId);
  if (!s) return null;
  return {
    subject_id: s.subject_id, subject_name: s.name,
    syllabus: s.syllabus || null,
    sim_tree: buildSim(shared, s, true),          // עם הניקוד, לבודק בלבד
    q1: { broken_step: s.q1.broken_step, ans_type: s.q1.ans_type,
          accepts: s.q1.accepts || [], fix: s.q1.key_fix, fix_ltr: !!s.q1.key_fix_ltr },
    q2: s.q2_key,
    q3: { drop: s.q3.key_drop, open: s.q3.key_open, close: s.q3.key_close },
    q4: s.q4.plans.map(p => ({ id: p.id, name: p.name, pro: p.key_pro, con: p.key_con })),
    q5: shared.sim_key,
    q6: { verdicts: s.q6.opts.map(o => ({ id: o.id, verdict: o.verdict })), must: s.q6.key_must }
  };
}

// השוואה סלחנית לתשובה המספרית: רווחים, פסיק עשרוני, וסימן כפל מיותר.
function normalizeNum(v) {
  return String(v == null ? '' : v).replace(/\s/g, '').replace(/,/g, '.').replace(/\*/g, '');
}

function checkQ1(subjectId, answer) {
  const s = getSubject(subjectId);
  if (!s || !answer) return { step_ok: null, ans_ok: null };
  const stepOk = Number(answer.step) === Number(s.q1.broken_step);
  let ansOk = null;                                   // בשאלות רבות-מלל אין תשובה אחת
  if (s.q1.ans_type === 'num') {
    const got = normalizeNum(answer.text);
    ansOk = (s.q1.accepts || []).some(a => normalizeNum(a) === got);
  }
  return { step_ok: stepOk, ans_ok: ansOk };
}

// בדיקת שפיות לבנק — נקראת ממסך הבודק, כמו content-health הקיים.
function health() {
  const { shared, subjects } = load();
  const problems = [];
  if (!shared.sim || !shared.sim.t1) problems.push('_shared.json: חסר עץ השיחה');
  for (const s of subjects) {
    const where = s.subject_id + '.json';
    if (!s.q1 || !Array.isArray(s.q1.steps) || s.q1.steps.length < 4) problems.push(where + ': פחות מארבעה שלבים בשאלה 1');
    const n = (s.q1.steps || []).length;
    if (!(s.q1.broken_step >= 1 && s.q1.broken_step <= n)) problems.push(where + ': broken_step מחוץ לטווח');
    if (s.q1.ans_type === 'num' && !(s.q1.accepts || []).length) problems.push(where + ': שאלה מספרית בלי accepts');
    if (!s.q1.key_fix) problems.push(where + ': חסר key_fix');
    if (!s.q4 || (s.q4.plans || []).length !== 3) problems.push(where + ': צריך בדיוק שלושה מערכי שיעור');
    for (const p of (s.q4 && s.q4.plans) || []) {
      if (!p.key_pro || !p.key_con) problems.push(where + ': למערך «' + p.name + '» חסר יתרון או מחיר');
    }
    const good = ((s.q6 && s.q6.opts) || []).filter(o => o.verdict === 'good').length;
    if (good < 1) problems.push(where + ': בשאלה 6 אין אף אפשרות סבירה');
    if (!s.check || !s.check_reply) problems.push(where + ': חסר מהלך «בוא נבדוק» לשיחה');
  }
  return { ok: problems.length === 0, subjects: subjects.length, problems };
}

// ---------------------------------------------------------------------------
// מודל הניקוד: מה אוטומטי, מה לפי רובריקה, וכמה שווה כל שאלה (סה"כ 24).
// ---------------------------------------------------------------------------
function scoringModel() {
  const sh = load().shared;
  return { scoring: sh.exam_scoring || {}, labels: sh.rubric_labels || {} };
}

function simMoveScore(shared, subj, path) {
  const tree = buildSim(shared, subj, true);
  if (!Array.isArray(path) || !path.length) return { pts: [], total: 0 };
  const pts = [];
  const o1 = tree.t1.opts.find(o => o.id === path[0].id); pts.push(o1 ? (o1.score || 0) : 0);
  if (path[1]) { const n2 = tree.t2[path[0].to] || { opts: [] }; const o2 = n2.opts.find(o => o.id === path[1].id); pts.push(o2 ? (o2.score || 0) : 0); }
  if (path[2]) { const n3 = tree.t3[path[1].to] || tree.t3.stuck; const o3 = n3.opts.find(o => o.id === path[2].id); pts.push(o3 ? (o3.score || 0) : 0); }
  return { pts, total: pts.reduce((a, b) => a + b, 0) };
}

// answers = { qid: {value, time_spent_sec} } · grades = { qid: {scores:{crit:0|1}, comment} }
// מחזיר לכל שאלה: auto (חלקים אוטומטיים), rubric (סימוני הבודק), points, max — וסה"כ.
function computeScore(subjectId, answers, grades) {
  const { shared } = load();
  const subj = getSubject(subjectId);
  const model = (shared.exam_scoring || {});
  const out = { questions: {}, total: 0, max: model.total || 24, complete: true };
  if (!subj) return out;
  const g = grades || {};
  const a = answers || {};
  const val = q => (a[q] && a[q].value) || {};

  for (const qid of ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']) {
    const m = model[qid] || {}; const row = { auto: {}, rubric: {}, points: 0, max: m.max || 0, label: m.label || qid };
    // --- חלקים אוטומטיים ---
    if (qid === 'q1') {
      const chk = checkQ1(subjectId, val('q1'));
      row.auto.step = chk.step_ok ? 1 : 0;
      if (subj.q1.ans_type === 'num') row.auto.fix = chk.ans_ok ? 1 : 0;
      else {                                            // תיקון מילולי — הבודק מסמן
        const gs = (g.q1 && g.q1.scores) || {};
        if (gs.fix_correct == null) row.complete = false;
        row.auto.fix = gs.fix_correct ? 1 : 0;
      }
    }
    if (qid === 'q5') {
      const mv = simMoveScore(shared, subj, val('q5').path);
      row.auto.moves = mv.total; row.auto.moves_pts = mv.pts;
    }
    if (qid === 'q6') {
      const pick = val('q6').pick;
      const opt = (subj.q6.opts || []).find(o => o.id === pick);
      row.auto.pick = opt ? (opt.verdict === 'good' ? 2 : opt.verdict === 'weak' ? 1 : 0) : 0;
    }
    // --- רובריקה (הבודק) ---
    let rub = 0;
    for (const c of (m.rubric || [])) {
      const gs = (g[qid] && g[qid].scores) || {};
      if (gs[c] == null) { row.complete = false; row.rubric[c] = null; }
      else { row.rubric[c] = gs[c] ? 1 : 0; rub += gs[c] ? 1 : 0; }
    }
    row.points = Object.keys(row.auto).filter(k => k !== 'moves_pts').reduce((s, k) => s + (row.auto[k] || 0), 0) + rub;
    row.points = Math.min(row.points, row.max);
    if (row.complete === false) out.complete = false;
    out.questions[qid] = row;
    out.total += row.points;
  }
  return out;
}

// טקסט לבודק ה-AI: השאלה, המפתח וההקשר לכל שאלה כתובה.
function aiPackFor(subjectId, answers) {
  const { shared } = load();
  const s = getSubject(subjectId);
  if (!s) return [];
  const k = keyFor(subjectId);
  const L = shared.rubric_labels || {};
  const a = answers || {};
  const txt = q => ((a[q] && a[q].value && a[q].value.text) || '');
  const steps = (s.q1.steps || []).map((t, i) => (i + 1) + '. ' + t.replace(/\\\(|\\\)|\\\[|\\\]/g, '')).join('\n');
  const list = [];
  if (s.q1.ans_type === 'text') list.push({
    qid: 'q1', subject: s.name, criteria: ['fix_correct'], labels: L,
    question: 'סמן את השלב שבו התשובה נשברת, וכתוב מה היה צריך להיכתב שם.',
    context: 'תשובת התלמיד בשלבים:\n' + steps,
    key: 'השלב השבור: ' + s.q1.broken_step + '. התיקון הנכון: ' + k.q1.fix,
    answer: txt('q1') });
  list.push({ qid: 'q2', subject: s.name, criteria: shared.q2.rubric, labels: L,
    question: shared.q2.ask, context: 'תשובת התלמיד בשלבים:\n' + steps + '\nהשלב השבור: ' + s.q1.broken_step,
    key: 'תשובה חזקה: ' + k.q2.strong + '\nתשובה חלשה (דגל): ' + k.q2.weak, answer: txt('q2') });
  list.push({ qid: 'q3', subject: s.name, criteria: shared.q3_rubric, labels: L,
    question: shared.q3_ask, context: 'התלמידה: ' + s.q3.profile + '\nההסבר של ה-AI: ' + s.q3.ai,
    key: 'מה מורידים: ' + k.q3.drop + '\nבמה פותחים: ' + k.q3.open + '\nבאיזה משפט מסיימים: ' + k.q3.close, answer: txt('q3') });
  const plan = (a.q4 && a.q4.value && a.q4.value.plan) || null;
  list.push({ qid: 'q4', subject: s.name, criteria: shared.q4_rubric, labels: L,
    question: shared.q4_ask + (plan ? (' (בחר במערך ' + plan + ')') : ''), context: s.q4.stem,
    key: k.q4.map(p => p.name + ' — יתרון: ' + p.pro + ' · מחיר: ' + p.con).join('\n'), answer: txt('q4') });
  const path = (a.q5 && a.q5.value && a.q5.value.path) || [];
  list.push({ qid: 'q5', subject: s.name, criteria: shared.sim.rubric, labels: L,
    question: shared.sim.reflect_ask,
    context: 'מסלול השיחה שהמועמד בחר:\n' + path.map((t, i) => 'מהלך ' + (i + 1) + ': ' + t.label + ' → ' + t.reply).join('\n'),
    key: (shared.sim_key || []).map(x => x.look + ': ' + x.good + ' | דגל: ' + x.flag).join('\n'), answer: txt('q5') });
  const pick = (a.q6 && a.q6.value && a.q6.value.pick) || null;
  list.push({ qid: 'q6', subject: s.name, criteria: shared.q6_rubric, labels: L,
    question: shared.q6_ask + (pick ? (' (בחר באפשרות ' + pick + ')') : ''), context: s.q6.stem,
    key: 'הנימוק חייב לכלול: ' + k.q6.must, answer: txt('q6') });
  return list;
}

module.exports = {
  load, reload, listSubjects, getSubject, durationSec,
  buildForCandidate, keyFor, checkQ1, health,
  scoringModel, computeScore, aiPackFor, instructions
};
