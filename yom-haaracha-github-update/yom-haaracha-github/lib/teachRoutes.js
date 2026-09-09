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
    if (c.status === 'registered') st.subjects = tc.listSubjects();
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
    res.json({ ok: true, remaining_sec: remainingSec(c) });
  });

  app.post('/api/teach/submit', authCandidate, (req, res) => {
    const c = req.cand;
    if (c.status === 'submitted') return res.json(stateOf(c));
    db.prepare("UPDATE teach_candidates SET status = 'submitted', finished_at = ? WHERE code = ?")
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
          extra_sec: c.extra_sec || 0
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
    res.json({
      candidate: {
        code: c.code, name: c.name, phone: c.phone, status: c.status,
        subject_id: c.subject_id, started_at: c.started_at, finished_at: c.finished_at,
        used_sec: c.started_at ? Math.floor(((c.finished_at || now()) - c.started_at) / 1000) : 0
      },
      exam: c.subject_id ? tc.buildForCandidate(c.subject_id) : null,
      answers, key, auto,
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
    db.prepare(`UPDATE teach_candidates SET status = 'registered', subject_id = NULL, started_at = NULL,
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
