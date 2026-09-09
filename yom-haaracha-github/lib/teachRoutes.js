// ============================================================================
//  בוחן ההוראה — כל המסלולים של המועמדים והפיקוח עליהם
//
//  מודול נפרד בכוונה. server.js מריץ את יום ההערכה החי, ואסור שתקלה כאן
//  תיגע שם. אין כאן שום שאילתה על examinees / slots / rounds.
//
//  השעון הוא של השרת. הדפדפן רק מציג אותו — הוא לא מחליט מתי נגמר הזמן.
// ============================================================================
const path = require('path');
const tc = require('./teachContent');
const teachAi = require('./teachAi');
const monday = require('./monday');
const nameMatch = require('./nameMatch');
const aiGrade = require('./aiGrade');

function register(app, deps) {
  const { db, now, newToken, authExaminer } = deps;

  // ---------------------------------------------------------------- עזרים
  const getByToken = db.prepare('SELECT * FROM teach_candidates WHERE token = ?');
  const getByCode  = db.prepare('SELECT * FROM teach_candidates WHERE code = ?');
  const getByName  = db.prepare('SELECT * FROM teach_candidates WHERE lower(trim(name)) = ?');

  function ev(code, kind, detail) {
    db.prepare('INSERT INTO teach_events (code, kind, detail, at) VALUES (?, ?, ?, ?)')
      .run(code || null, kind, detail ? String(detail).slice(0, 500) : null, now());
  }

  function authCandidate(req, res, next) {
    const token = (req.headers['x-token'] || '').trim();
    const c = token && getByToken.get(token);
    if (!c) return res.status(401).json({ error: 'לא מחובר. יש להתחבר מחדש.' });
    req.cand = c;
    next();
  }

  // כמה שניות נשארו. מקור אמת יחיד — נגזר מהשעון של השרת בלבד.
  // ⚠ החותמות במסד הן מילישניות (Date.now), והשדות *_sec הם שניות —
  //   בדיוק כמו ב-slots וב-day_rounds. ערבוב היחידות כאן מאפס את השעון.
  function remainingSec(c) {
    const total = (c.duration_sec || 1500) + (c.extra_sec || 0);
    if (c.review) return total;          // מצב בדיקה — השעון לא זז
    if (!c.started_at) return total;
    const pausedNow = c.paused ? Math.floor((now() - (c.paused_at || now())) / 1000) : 0;
    const elapsed = Math.floor((now() - c.started_at) / 1000) - (c.paused_accum_sec || 0) - pausedNow;
    return Math.max(0, total - elapsed);
  }

  function autoSubmitIfOver(c) {
    if (c.status !== 'running') return c;
    if (remainingSec(c) > 0) return c;
    db.prepare("UPDATE teach_candidates SET status = 'submitted', finished_at = ? WHERE code = ?")
      .run(now(), c.code);
    ev(c.code, 'submit', 'נגמר הזמן');
    return getByCode.get(c.code);
  }

  function answersOf(code) {
    const rows = db.prepare('SELECT qid, value, time_spent_sec FROM teach_answers WHERE code = ?').all(code);
    const out = {};
    for (const r of rows) {
      let v = null;
      try { v = r.value ? JSON.parse(r.value) : null; } catch (e) { v = null; }
      out[r.qid] = { value: v, time_spent_sec: r.time_spent_sec || 0 };
    }
    return out;
  }

  function stateOf(c) {
    c = autoSubmitIfOver(c);
    const st = {
      name: c.name, status: c.status, subject_id: c.subject_id,
      remaining_sec: remainingSec(c), paused: !!c.paused, review: !!c.review,
      duration_sec: (c.duration_sec || 1500) + (c.extra_sec || 0)
    };
    if (c.status === 'running' && c.subject_id) {
      st.exam = tc.buildForCandidate(c.subject_id);
      st.answers = answersOf(c.code);
    }
    if (c.status === 'registered') { st.subjects = tc.listSubjects(); st.instructions = tc.instructions(); }
    try { st.reopened = c.reopened_json ? JSON.parse(c.reopened_json) : []; } catch (e) { st.reopened = []; }
    st.reached = c.reached || 0;
    if (c.status === 'running' && c.subject_id) st.aids = (tc.getSubject(c.subject_id) || {}).aids || '';
    return st;
  }

  // ============================================================ המועמד
  app.get('/teach', (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'teach.html')));

  app.get('/api/teach/subjects', (req, res) => res.json({ subjects: tc.listSubjects() }));

  // מסך הפיקוח והבדיקה. הדף עצמו פתוח; כל הנתונים שבו מאחורי סיסמת המנהל.
  app.get('/teach-grade', (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'teach-grade.html')));

  // כניסה: שם + סיסמה + טלפון. פעם ראשונה = נרשם; אחר כך = שחזור.
  app.post('/api/teach/login', (req, res) => {
    const name  = String((req.body && req.body.name)  || '').trim();
    const pin   = String((req.body && req.body.pin)   || '').trim();
    const phone = String((req.body && req.body.phone) || '').trim();
    if (!name || !pin || !phone) return res.status(400).json({ error: 'נדרשים שם, סיסמה וטלפון.' });
    if (name.length < 2)  return res.status(400).json({ error: 'שם קצר מדי.' });
    if (pin.length < 4)   return res.status(400).json({ error: 'הסיסמה צריכה להיות באורך 4 תווים לפחות.' });
    if (!/^[0-9\-+ ]{9,15}$/.test(phone)) return res.status(400).json({ error: 'מספר טלפון לא תקין.' });

    let c = getByName.get(name.toLowerCase());
    if (c && String(c.pin) !== pin) {
      return res.status(409).json({ error: 'השם הזה כבר רשום עם סיסמה אחרת. אם זה אתה — הזן את הסיסמה שבחרת. אחרת פנה למנהל.' });
    }
    const token = newToken();
    if (!c) {
      const code = 'T' + Math.random().toString(36).slice(2, 8).toUpperCase();
      db.prepare(`INSERT INTO teach_candidates (code, name, pin, phone, token, duration_sec, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(code, name, pin, phone, token, tc.durationSec(), now());
      c = getByCode.get(code);
      ev(code, 'login', 'נרשם: ' + name);
    } else {
      db.prepare('UPDATE teach_candidates SET token = ?, phone = ? WHERE code = ?').run(token, phone, c.code);
      c = getByCode.get(c.code);
      ev(c.code, 'login', 'שחזור');
    }
    res.json({ token, state: stateOf(c) });
  });

  app.get('/api/teach/state', authCandidate, (req, res) => res.json(stateOf(req.cand)));

  // בחירת מקצוע + הפעלת השעון. ⚠ אין דרך חזרה — זו נקודת האל-חזור של המבחן.
  app.post('/api/teach/start', authCandidate, (req, res) => {
    const c = req.cand;
    if (c.status === 'submitted') return res.status(409).json({ error: 'המבחן כבר הוגש.' });
    if (c.status === 'running')   return res.json(stateOf(c));
    const sid = String((req.body && req.body.subject_id) || '').trim();
    if (!tc.getSubject(sid)) return res.status(400).json({ error: 'מקצוע לא מוכר.' });
    db.prepare("UPDATE teach_candidates SET subject_id = ?, status = 'running', started_at = ?, duration_sec = ? WHERE code = ?")
      .run(sid, now(), tc.durationSec(), c.code);
    ev(c.code, 'start', sid);
    res.json(stateOf(getByCode.get(c.code)));
  });

  // שמירה אוטומטית. נקראת תדיר, ולכן idempotent לחלוטין.
  app.post('/api/teach/answer', authCandidate, (req, res) => {
    let c = autoSubmitIfOver(req.cand);
    if (c.status !== 'running') return res.status(409).json({ error: 'המבחן אינו פעיל.' });
    const qid = String((req.body && req.body.qid) || '').trim();
    if (!/^q[1-6]$/.test(qid)) return res.status(400).json({ error: 'מזהה שאלה לא תקין.' });
    const value = (req.body && req.body.value) !== undefined ? req.body.value : null;
    const spent = Math.max(0, Math.min(3600, Number((req.body && req.body.time_spent_sec) || 0)));
    db.prepare(`INSERT INTO teach_answers (code, qid, value, started_at, updated_at, time_spent_sec)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(code, qid) DO UPDATE SET
                  value = excluded.value,
                  updated_at = excluded.updated_at,
                  time_spent_sec = MAX(teach_answers.time_spent_sec, excluded.time_spent_sec)`)
      .run(c.code, qid, JSON.stringify(value), now(), now(), spent);
    const reached = Number((req.body || {}).reached);
    if (Number.isInteger(reached) && reached >= 0 && reached <= 5) {
      db.prepare('UPDATE teach_candidates SET reached = MAX(reached, ?) WHERE code = ?').run(reached, c.code);
    }
    res.json({ ok: true, remaining_sec: remainingSec(c) });
  });

  app.post('/api/teach/submit', authCandidate, (req, res) => {
    const c = req.cand;
    if (c.status === 'submitted') return res.json(stateOf(c));
    db.prepare("UPDATE teach_candidates SET status = 'submitted', finished_at = ?, reopened_json = NULL WHERE code = ?")
      .run(now(), c.code);
    ev(c.code, 'submit', 'הגיש');
    res.json(stateOf(getByCode.get(c.code)));
  });

  // ============================================================ הפיקוח
  app.get('/api/examiner/teach/list', authExaminer, (req, res) => {
    const rows = db.prepare('SELECT * FROM teach_candidates ORDER BY created_at DESC').all();
    const subs = {};
    for (const s of tc.listSubjects()) subs[s.id] = s.name;
    res.json({
      candidates: rows.map(c => {
        const answered = db.prepare('SELECT COUNT(*) n FROM teach_answers WHERE code = ? AND value IS NOT NULL AND value != \'null\'').get(c.code).n;
        return {
          code: c.code, name: c.name, phone: c.phone,
          subject_id: c.subject_id, subject_name: subs[c.subject_id] || null,
          status: c.status, paused: !!c.paused, review: !!c.review,
          remaining_sec: remainingSec(autoSubmitIfOver(c)),
          answered, total: 6,
          started_at: c.started_at, finished_at: c.finished_at,
          extra_sec: c.extra_sec || 0,
          total_score: c.total_score, graded_at: c.graded_at,
          monday_item_id: c.monday_item_id, monday_sent_at: c.monday_sent_at
        };
      }),
      now: now()
    });
  });

  // כרטיס מועמד: התשובות, הזמן פר שאלה, ומפתח הבדיקה של המקצוע.
  app.get('/api/examiner/teach/candidate/:code', authExaminer, (req, res) => {
    const c = getByCode.get(String(req.params.code));
    if (!c) return res.status(404).json({ error: 'מועמד לא נמצא.' });
    const answers = answersOf(c.code);
    const key = c.subject_id ? tc.keyFor(c.subject_id) : null;
    const auto = (key && answers.q1) ? tc.checkQ1(c.subject_id, answers.q1.value) : null;
    const grades = gradesOf(c.code);
    res.json({
      candidate: {
        code: c.code, name: c.name, phone: c.phone, status: c.status,
        subject_id: c.subject_id, started_at: c.started_at, finished_at: c.finished_at,
        used_sec: c.started_at ? Math.floor(((c.finished_at || now()) - c.started_at) / 1000) : 0,
        total_score: c.total_score, graded_at: c.graded_at
      },
      exam: c.subject_id ? tc.buildForCandidate(c.subject_id) : null,
      answers, key, auto,
      grades,
      score: c.subject_id ? tc.computeScore(c.subject_id, answers, grades) : null,
      scoring: tc.scoringModel(),
      ai_available: aiGrade.hasApiKey(),
      monday: (function () { const fb = fixedBoard(); return {
                board_id: c.monday_board_id, item_id: c.monday_item_id, item_name: c.monday_item_name, sent_at: c.monday_sent_at,
                has_token: monday.hasToken(),
                fixed_board: fb.id, fixed_board_name: fb.name, fixed_is_default: fb.is_default,
                fixed_mapping: savedMapping(fb.id) }; })(),
      reopened: (function () { try { return c.reopened_json ? JSON.parse(c.reopened_json) : []; } catch (e) { return []; } })(),
      events: db.prepare('SELECT kind, detail, at FROM teach_events WHERE code = ? ORDER BY at').all(c.code)
    });
  });

  app.post('/api/examiner/teach/pause', authExaminer, (req, res) => {
    const c = getByCode.get(String((req.body && req.body.code) || ''));
    if (!c) return res.status(404).json({ error: 'מועמד לא נמצא.' });
    if (c.paused) {
      const add = Math.max(0, Math.floor((now() - (c.paused_at || now())) / 1000));
      db.prepare('UPDATE teach_candidates SET paused = 0, paused_at = NULL, paused_accum_sec = paused_accum_sec + ? WHERE code = ?')
        .run(add, c.code);
      ev(c.code, 'admin', 'המשך אחרי ' + add + ' שניות');
    } else {
      db.prepare('UPDATE teach_candidates SET paused = 1, paused_at = ? WHERE code = ?').run(now(), c.code);
      ev(c.code, 'admin', 'השהיה');
    }
    res.json({ ok: true });
  });

  // פתיחה מחדש: שאלה מסוימת לעריכה, ו/או המבחן כולו אחרי הגשה (עם תוספת זמן).
  app.post('/api/examiner/teach/reopen', authExaminer, (req, res) => {
    const b = req.body || {};
    const c = getByCode.get(String(b.code || ''));
    if (!c) return res.status(404).json({ error: 'מועמד לא נמצא.' });
    if (!c.started_at) return res.status(400).json({ error: 'המועמד עוד לא התחיל.' });
    let reopened = []; try { reopened = c.reopened_json ? JSON.parse(c.reopened_json) : []; } catch (e) { }
    const qid = String(b.qid || '');
    if (qid && /^q[1-6]$/.test(qid) && reopened.indexOf(qid) < 0) reopened.push(qid);
    const minutes = Math.max(0, Math.min(60, Number(b.minutes || 0)));
    const wasSubmitted = c.status === 'submitted';
    db.prepare(`UPDATE teach_candidates SET status = 'running', finished_at = NULL, reopened_json = ?,
                extra_sec = extra_sec + ? WHERE code = ?`)
      .run(JSON.stringify(reopened), (wasSubmitted && !minutes ? 5 : minutes) * 60, c.code);
    ev(c.code, 'admin', 'פתיחה מחדש' + (qid ? ' של ' + qid : ' של המבחן') + (wasSubmitted ? ' (אחרי הגשה)' : ''));
    res.json({ ok: true, reopened });
  });

  // סיום כפוי — כמו «סיים סבב» ביום הערכה: מה שנשמר עד עכשיו הוא התשובה.
  app.post('/api/examiner/teach/force-submit', authExaminer, (req, res) => {
    const c = getByCode.get(String((req.body && req.body.code) || ''));
    if (!c) return res.status(404).json({ error: 'מועמד לא נמצא.' });
    db.prepare("UPDATE teach_candidates SET status = 'submitted', finished_at = ?, reopened_json = NULL WHERE code = ?").run(now(), c.code);
    ev(c.code, 'admin', 'הוגש על ידי המנהל');
    res.json({ ok: true });
  });

  app.post('/api/examiner/teach/extra-time', authExaminer, (req, res) => {
    const c = getByCode.get(String((req.body && req.body.code) || ''));
    if (!c) return res.status(404).json({ error: 'מועמד לא נמצא.' });
    const min = Math.max(-60, Math.min(60, Number((req.body && req.body.minutes) || 0)));
    db.prepare('UPDATE teach_candidates SET extra_sec = MAX(0, extra_sec + ?) WHERE code = ?').run(min * 60, c.code);
    ev(c.code, 'admin', 'תוספת זמן: ' + min + ' דק׳');
    res.json({ ok: true });
  });

  // איפוס מלא — מוחק גם את התשובות. דורש אישור מפורש מהלקוח.
  app.post('/api/examiner/teach/reset', authExaminer, (req, res) => {
    const c = getByCode.get(String((req.body && req.body.code) || ''));
    if (!c) return res.status(404).json({ error: 'מועמד לא נמצא.' });
    db.prepare('DELETE FROM teach_answers WHERE code = ?').run(c.code);
    db.prepare('DELETE FROM teach_grades WHERE code = ?').run(c.code);
    db.prepare(`UPDATE teach_candidates SET status = 'registered', subject_id = NULL, started_at = NULL, reached = 0, reopened_json = NULL,
                finished_at = NULL, paused = 0, paused_at = NULL, paused_accum_sec = 0, extra_sec = 0
                WHERE code = ?`).run(c.code);
    ev(c.code, 'admin', 'איפוס מלא');
    res.json({ ok: true });
  });

  app.post('/api/examiner/teach/delete', authExaminer, (req, res) => {
    const code = String((req.body && req.body.code) || '');
    db.prepare('DELETE FROM teach_answers WHERE code = ?').run(code);
    db.prepare('DELETE FROM teach_grades WHERE code = ?').run(code);
    db.prepare('DELETE FROM teach_candidates WHERE code = ?').run(code);
    ev(null, 'admin', 'מחיקת מועמד ' + code);
    res.json({ ok: true });
  });

  // «פתח מבחן לבדיקה» — מועמד־בדיקה אחד לכל מקצוע, שעון כבוי, תשובות מאופסות.
  // מחזיר קישור עם האסימון בתוכו, כדי שהמנהל לא יצטרך להתחבר בכלל.
  app.post('/api/examiner/teach/review-open', authExaminer, (req, res) => {
    const sid = String((req.body && req.body.subject_id) || '').trim();
    const subj = tc.getSubject(sid);
    if (!subj) return res.status(400).json({ error: 'מקצוע לא מוכר.' });

    const name = 'בדיקה · ' + subj.name;
    const token = newToken();
    let c = getByName.get(name.toLowerCase());
    if (!c) {
      const code = 'R' + sid.slice(0, 4).toUpperCase();
      db.prepare(`INSERT INTO teach_candidates (code, name, pin, phone, token, subject_id, review, duration_sec, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(code, name, 'review', '0000000000', token, sid, tc.durationSec(), now());
      c = getByCode.get(code);
    }
    // כל פתיחה מתחילה מבחן נקי — אחרת הבדיקה הקודמת מתערבבת בחדשה
    db.prepare('DELETE FROM teach_answers WHERE code = ?').run(c.code);
    db.prepare('DELETE FROM teach_grades WHERE code = ?').run(c.code);
    db.prepare(`UPDATE teach_candidates SET token = ?, subject_id = ?, review = 1, status = 'running',
                started_at = ?, finished_at = NULL, paused = 0, paused_at = NULL,
                paused_accum_sec = 0, extra_sec = 0 WHERE code = ?`)
      .run(token, sid, now(), c.code);
    ev(c.code, 'admin', 'נפתח לבדיקה: ' + subj.name);
    res.json({ url: '/teach#t=' + token, name, subject: subj.name });
  });

  // ============================================================ בדיקה וציונים
  function gradesOf(code) {
    const rows = db.prepare('SELECT qid, scores_json, ai_json, comment, source, demo FROM teach_grades WHERE code = ?').all(code);
    const out = {};
    for (const r of rows) {
      let sc = null, ai = null;
      try { sc = r.scores_json ? JSON.parse(r.scores_json) : null; } catch (e) { }
      try { ai = r.ai_json ? JSON.parse(r.ai_json) : null; } catch (e) { }
      out[r.qid] = { scores: sc || {}, ai, comment: r.comment || '', source: r.source || null, demo: !!r.demo };
    }
    return out;
  }
  function saveTotal(c) {
    const sc = tc.computeScore(c.subject_id, answersOf(c.code), gradesOf(c.code));
    db.prepare('UPDATE teach_candidates SET total_score = ?, graded_at = ? WHERE code = ?')
      .run(sc.complete ? sc.total : null, sc.complete ? now() : null, c.code);
    return sc;
  }
  function cfgGet(k) { const r = db.prepare('SELECT value FROM config WHERE key = ?').get(k); return r ? r.value : null; }
  function cfgSet(k, v) {
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
  }

  // סימון ידני של הבודק — מקור האמת. דורס כל הצעה של AI.
  app.post('/api/examiner/teach/grade', authExaminer, (req, res) => {
    const b = req.body || {};
    const c = getByCode.get(String(b.code || ''));
    if (!c) return res.status(404).json({ error: 'מועמד לא נמצא.' });
    const qid = String(b.qid || '');
    if (!/^q[1-6]$/.test(qid)) return res.status(400).json({ error: 'מזהה שאלה לא תקין.' });
    const scores = (b.scores && typeof b.scores === 'object') ? b.scores : {};
    const clean = {};
    Object.keys(scores).forEach(k => { if (scores[k] === null) clean[k] = null; else clean[k] = scores[k] ? 1 : 0; });
    const comment = String(b.comment == null ? '' : b.comment).slice(0, 2000);
    db.prepare(`INSERT INTO teach_grades (code, qid, scores_json, comment, source, graded_at)
                VALUES (?, ?, ?, ?, 'manual', ?)
                ON CONFLICT(code, qid) DO UPDATE SET scores_json = excluded.scores_json,
                  comment = excluded.comment, source = 'manual', graded_at = excluded.graded_at`)
      .run(c.code, qid, JSON.stringify(clean), comment, now());
    ev(c.code, 'grade', qid);
    res.json({ ok: true, score: saveTotal(c), grades: gradesOf(c.code) });
  });

  // בדיקת AI לכל התשובות הכתובות. מציע בלבד: ממלא רק שורות שהבודק עוד לא סימן.
  app.post('/api/examiner/teach/ai-grade', authExaminer, async (req, res) => {
    const c = getByCode.get(String((req.body && req.body.code) || ''));
    if (!c) return res.status(404).json({ error: 'מועמד לא נמצא.' });
    if (!c.subject_id) return res.status(400).json({ error: 'המועמד לא בחר מקצוע.' });
    const answers = answersOf(c.code);
    const pack = tc.aiPackFor(c.subject_id, answers);
    let results;
    try { results = await teachAi.gradeMany(pack); }
    catch (e) { return res.status(500).json({ error: 'בדיקת ה-AI נכשלה: ' + String(e.message || e).slice(0, 200) }); }
    const existing = gradesOf(c.code);
    let demo = false;
    for (const qid of Object.keys(results)) {
      const r = results[qid]; if (r.demo) demo = true;
      const cur = existing[qid] || { scores: {}, comment: '' };
      const scores = Object.assign({}, cur.scores);
      const manual = cur.source === 'manual';
      Object.keys(r.criteria || {}).forEach(k => {
        // הצעת AI ממלאת רק מה שהבודק לא סימן בעצמו
        if (!manual || scores[k] == null) scores[k] = r.criteria[k].met ? 1 : 0;
      });
      db.prepare(`INSERT INTO teach_grades (code, qid, scores_json, ai_json, comment, source, demo, graded_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(code, qid) DO UPDATE SET scores_json = excluded.scores_json, ai_json = excluded.ai_json,
                    source = CASE WHEN teach_grades.source = 'manual' THEN 'manual' ELSE 'ai' END,
                    demo = excluded.demo, graded_at = excluded.graded_at`)
        .run(c.code, qid, JSON.stringify(scores), JSON.stringify(r), cur.comment || '', manual ? 'manual' : 'ai', r.demo ? 1 : 0, now());
    }
    ev(c.code, 'ai_grade', demo ? 'הדגמה' : 'אמיתי');
    res.json({ ok: true, demo, grades: gradesOf(c.code), score: saveTotal(c) });
  });

  // ============================================================ מאנדיי
  const TEACH_FIELDS = [
    { id: 'first',   label: 'שם פרטי' },
    { id: 'last',    label: 'שם משפחה' },
    { id: 'phone',   label: 'טלפון' },
    { id: 'subject', label: 'מקצוע' },
    { id: 'total',   label: 'ציון (מתוך 24)' },
    { id: 'percent', label: 'ציון באחוזים' },
    { id: 'date',    label: 'תאריך המבחן' },
    { id: 'verbal',  label: 'הערכה מילולית (שורה אחת)' },
    { id: 'summary', label: 'סיכום הבדיקה (טקסט מלא)' },
  ];

  // ---- הבורד הקבוע: «שאלון מועמדות למורים» — המועמדים כבר קיימים בו (מילאו טופס),
  // לכן שליחה = מציאת השורה של המועמד לפי שם ועדכון שתי העמודות שהמנהל הוסיף.
  // אפשר לשנות בורד/מיפוי מהפאנל; מה שנשמר ב-config גובר על ברירת המחדל.
  const DEFAULT_BOARD = { id: '18414628784', name: 'שאלון מועמדות למורים - 2026/27' };
  const DEFAULT_MAP_TITLES = {
    total:  [/^ציון מבחן$/, /^ציון$/, /^ציון המבחן$/],
    verbal: [/^הערכה מילולית$/, /הערכה מילולית/],
  };
  function fixedBoard() {
    const id = cfgGet('teach_monday_board');
    if (id) return { id: String(id), name: cfgGet('teach_monday_board_name') || null, is_default: false };
    return { id: DEFAULT_BOARD.id, name: DEFAULT_BOARD.name, is_default: true };
  }
  function savedMapping(boardId) {
    try { const m = JSON.parse(cfgGet('teach_monday_map_' + boardId) || 'null'); return (m && Object.keys(m).length) ? m : null; } catch (e) { return null; }
  }
  function defaultMapping(cols) {
    const m = {};
    Object.keys(DEFAULT_MAP_TITLES).forEach(f => {
      const c = cols.find(col => DEFAULT_MAP_TITLES[f].some(re => re.test(String(col.title || '').trim())));
      if (c) m[f] = c.id;
    });
    return m;
  }
  // התאמת המועמד לשורה בבורד לפי שם — אותו מנוע כמו ביום הערכה (nameMatch).
  function pickItem(candidateName, items) {
    const m = nameMatch.matchName(candidateName, items.map(it => ({ code: it.id, name: it.name })));
    return { exact: m.exact ? { id: m.exact.code, name: m.exact.name } : null,
             suggestions: (m.suggestions || []).slice(0, 6).map(s => ({ id: s.code, name: s.name, reason: s.reason, confidence: s.confidence })) };
  }
  app.get('/api/examiner/teach/monday/setup', authExaminer, (req, res) => {
    const fb = fixedBoard();
    res.json({ fields: TEACH_FIELDS, board_id: fb.id, board_name: fb.name, is_default: fb.is_default,
               mapping: savedMapping(fb.id), has_token: monday.hasToken() });
  });

  function summaryText(c, exam, answers, grades, score) {
    const lines = [];
    lines.push('ציון: ' + score.total + ' / ' + score.max + (score.complete ? '' : ' (בדיקה לא הושלמה)'));
    for (const qid of ['q1','q2','q3','q4','q5','q6']) {
      const q = score.questions[qid]; if (!q) continue;
      const g = grades[qid] || {};
      let l = q.label + ': ' + q.points + '/' + q.max;
      if (g.comment) l += ' — ' + g.comment;
      else if (g.ai && g.ai.conclusion && !g.ai.demo) l += ' — ' + g.ai.conclusion;
      lines.push(l);
    }
    return lines.join('\n').slice(0, 1900);
  }

  // שורה אחת לעמודת טקסט: מקצוע · ציון · פירוט לפי שאלה · הערות הבודק.
  function verbalText(subjName, grades, score) {
    const parts = [subjName + ' · ' + score.total + '/' + score.max + ' (' + Math.round(100 * score.total / (score.max || 24)) + '%)' + (score.complete ? '' : ' · בדיקה לא הושלמה')];
    const qs = [];
    for (const qid of ['q1','q2','q3','q4','q5','q6']) { const q = score.questions[qid]; if (q) qs.push(q.label + ' ' + q.points + '/' + q.max); }
    parts.push(qs.join(', '));
    const notes = [];
    for (const qid of ['q1','q2','q3','q4','q5','q6']) { const g = grades[qid] || {}; if (g.comment) notes.push(String(g.comment).replace(/\s+/g, ' ').trim()); }
    if (notes.length) parts.push(notes.join(' | '));
    return parts.join(' · ').slice(0, 900);
  }

  app.post('/api/examiner/teach/monday/send', authExaminer, async (req, res) => {
    const b = req.body || {};
    const c = getByCode.get(String(b.code || ''));
    if (!c) return res.status(404).json({ error: 'מועמד לא נמצא.' });
    if (!c.subject_id) return res.status(400).json({ error: 'המועמד לא בחר מקצוע.' });
    const boardId = String(b.board_id || fixedBoard().id);
    let colTypes = {}, cols = [], boardName = b.board_name || '';
    try { const info = await monday.boardColumns(boardId); cols = info.columns; boardName = boardName || info.name || ''; cols.forEach(col => { colTypes[col.id] = col.type; }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    // מיפוי: מה שנשלח מהפאנל ← מה שנשמר לבורד הזה ← ניחוש לפי שמות העמודות («ציון מבחן», «הערכה מילולית»)
    const explicit = (b.mapping && typeof b.mapping === 'object' && Object.keys(b.mapping).length) ? b.mapping : null;
    const mapping = explicit || savedMapping(boardId) || defaultMapping(cols);
    if (!Object.keys(mapping).length) {
      return res.status(400).json({ error: 'לא נמצאו בבורד עמודות בשם «ציון מבחן» או «הערכה מילולית». פתח «שנה בורד / מיפוי» ובחר עמודות ידנית.' });
    }

    const answers = answersOf(c.code), grades = gradesOf(c.code);
    const score = tc.computeScore(c.subject_id, answers, grades);
    const subj = tc.getSubject(c.subject_id);
    const started = c.started_at ? new Date(c.started_at) : new Date();
    const dateStr = started.getFullYear() + '-' + String(started.getMonth() + 1).padStart(2, '0') + '-' + String(started.getDate()).padStart(2, '0');
    const nm = String(c.name || '').trim().split(/\s+/);
    const raw = {
      first: nm[0] || '', last: nm.slice(1).join(' ') || '',
      phone: c.phone, subject: subj ? subj.name : c.subject_id,
      total: score.total, percent: Math.round(100 * score.total / (score.max || 24)),
      date: dateStr, summary: summaryText(c, null, answers, grades, score),
      verbal: verbalText(subj ? subj.name : c.subject_id, grades, score),
    };
    const vals = {};
    for (const f of Object.keys(mapping)) {
      const colId = mapping[f]; if (!colId || raw[f] == null || raw[f] === '') continue;
      const t = colTypes[colId] || 'text';
      let v = raw[f];
      // ציון לעמודת טקסט — קריא לאדם, לא מספר בודד
      if (f === 'total' && t !== 'numbers') v = score.total + ' / ' + score.max + ' (' + raw.percent + '%)';
      if (f === 'percent' && t !== 'numbers') v = raw.percent + '%';
      vals[colId] = (t === 'date') ? { date: raw.date } : monday.columnValue(t, v);
    }
    try {
      // איזו שורה? (1) מה שכבר נשלח לבורד הזה (2) בחירה מפורשת מהמנהל (3) התאמה לפי שם (4) יצירה — רק אם המנהל ביקש
      let itemId = (c.monday_item_id && String(c.monday_board_id) === boardId) ? String(c.monday_item_id) : null;
      let itemName = itemId ? (c.monday_item_name || '') : '';
      if (!itemId && b.item_id) { itemId = String(b.item_id); itemName = String(b.item_name || ''); }
      let created = false;
      if (!itemId && !b.create_new) {
        const items = await monday.boardItems(boardId);
        const pick = pickItem(c.name, items);
        if (pick.exact) { itemId = pick.exact.id; itemName = pick.exact.name; }
        else {
          return res.status(409).json({
            needs_pick: true, board_id: boardId, board_name: boardName, candidate: c.name,
            suggestions: pick.suggestions, board_size: items.length,
            error: pick.suggestions.length
              ? 'לא נמצאה בבורד שורה בשם «' + c.name + '». אולי אחת מאלה?'
              : 'לא נמצאה בבורד שורה בשם «' + c.name + '» (' + items.length + ' שורות בבורד). אפשר ליצור שורה חדשה.',
          });
        }
      }
      if (itemId) { await monday.setValues(boardId, itemId, vals); }
      else { itemId = await monday.createItem(boardId, c.name, vals, b.group_id || null); itemName = c.name; created = true; }
      db.prepare('UPDATE teach_candidates SET monday_board_id = ?, monday_item_id = ?, monday_item_name = ?, monday_sent_at = ? WHERE code = ?')
        .run(boardId, itemId, itemName || null, now(), c.code);
      cfgSet('teach_monday_board', boardId);
      if (boardName) cfgSet('teach_monday_board_name', String(boardName).slice(0, 120));
      cfgSet('teach_monday_map_' + boardId, JSON.stringify(mapping));
      ev(c.code, 'monday', (created ? 'נוצרה שורה «' : 'עודכנה שורה «') + (itemName || itemId) + '» בבורד ' + (boardName || boardId));
      res.json({ ok: true, item_id: itemId, item_name: itemName, created, sent: Object.keys(vals).length,
                 board_id: boardId, board_name: boardName, mapping, fields: Object.keys(mapping) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/examiner/teach/health', authExaminer, (req, res) => res.json(tc.health()));
  // המפתח *יחד עם* השאלות עצמן — כדי שהמנהל יעבור על התוכן במסך אחד.
  app.get('/api/examiner/teach/key/:subject', authExaminer, (req, res) => {
    const sid = String(req.params.subject);
    const k = tc.keyFor(sid);
    if (!k) return res.status(404).json({ error: 'מקצוע לא מוכר.' });
    k.exam = tc.buildForCandidate(sid);
    res.json(k);
  });
}

module.exports = { register };
