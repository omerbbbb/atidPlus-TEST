/* ==========================================================================
 *  מועמדים להוראה — מסך הפיקוח והבדיקה
 *
 *  שתי לשוניות: המועמדים (חי, עם השהיה ותוספת זמן) ומפתח הבדיקה לכל מקצוע.
 *  כשפותחים מועמד — התשובה שלו יושבת *לצד* מה שצריך היה להיות.
 * ========================================================================== */
(function () {
  var root = document.getElementById('root');
  var KEY = 'examiner_token';
  var S = { token: null, tab: 'people', subject: 'math5', open: null, list: null, key: null, card: null, err: '' };
  var poll = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function mt(s) { return window.renderMathText ? window.renderMathText(s) : esc(s); }
  function mins(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function api(path, data) {
    return fetch(path, {
      method: data ? 'POST' : 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, S.token ? { 'x-token': S.token } : {}),
      body: data ? JSON.stringify(data) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'שגיאת שרת'); e.status = r.status; e.data = j; throw e; }
        return j;
      });
    });
  }

  // ------------------------------------------------------------- כניסה
  function drawLogin() {
    root.innerHTML =
      '<div class="g-login"><h2>מועמדים להוראה</h2>' +
      '<p>מסך פיקוח ובדיקה. נדרשת סיסמת המנהל.</p>' +
      '<input id="g-pw" type="password" placeholder="סיסמה" />' +
      '<button id="g-in">כניסה</button><div class="g-err" id="g-err">' + esc(S.err) + '</div></div>';
    function go() {
      api('/api/examiner/login', { password: document.getElementById('g-pw').value }).then(function (r) {
        S.token = r.token; S.err = '';
        try { sessionStorage.setItem(KEY, r.token); } catch (e) { }
        boot();
      }).catch(function (e) { document.getElementById('g-err').textContent = e.message; });
    }
    document.getElementById('g-in').onclick = go;
    document.getElementById('g-pw').onkeydown = function (e) { if (e.key === 'Enter') go(); };
    document.getElementById('g-pw').focus();
  }

  // ------------------------------------------------------------- שלד
  function shell(inner) {
    return '<div class="g-top">' +
             '<h1>מועמדים להוראה</h1>' +
             '<span class="sub">פיקוח ובדיקה · נפרד לגמרי מיום ההערכה</span>' +
             '<span class="spacer"></span>' +
             '<button class="g-btn" id="g-refresh">רענן</button>' +
           '</div>' +
           '<div class="g-tabs">' +
             '<button class="g-tab' + (S.tab === 'people' ? ' sel' : '') + '" data-t="people">המועמדים</button>' +
             '<button class="g-tab' + (S.tab === 'key' ? ' sel' : '') + '" data-t="key">מפתח הבדיקה</button>' +
           '</div>' + inner;
  }

  function wireShell() {
    Array.prototype.forEach.call(document.querySelectorAll('.g-tab'), function (b) {
      b.onclick = function () { S.tab = b.getAttribute('data-t'); S.open = null; render(); };
    });
    var r = document.getElementById('g-refresh');
    if (r) r.onclick = function () { refresh(); };
  }

  // ------------------------------------------------------------- המועמדים
  function statusPill(c) {
    if (c.paused) return '<span class="g-pill hold">מושהה</span>';
    if (c.status === 'running') return '<span class="g-pill run">באמצע</span>';
    if (c.status === 'submitted') return '<span class="g-pill done">הוגש</span>';
    return '<span class="g-pill wait">נרשם</span>';
  }

  // פס לבדיקה עצמית: כפתור לכל מקצוע. נפתח בלשונית חדשה, מחובר, בלי שעון.
  function reviewBar() {
    var subs = (S.list && S.list.subjects) || [];
    if (!subs.length) return '';
    return '<div class="g-review"><div class="g-review-t">בדיקה עצמית — עבור על מבחן בעצמך' +
           '<span>נפתח מחובר, המקצוע נבחר, והשעון כבוי. כל פתיחה מתחילה מבחן נקי.</span></div>' +
           '<div class="g-act">' + subs.map(function (s) {
             return '<button class="g-btn rev" data-rev="' + esc(s.id) + '">' + esc(s.name) + '</button>';
           }).join('') + '</div></div>';
  }

  function peopleHtml() {
    var rows = (S.list && S.list.candidates) || [];
    if (!rows.length) return reviewBar() + '<div class="g-empty">עדיין לא נכנס אף מועמד.<br />הקישור למועמדים: <b>/teach</b></div>';
    return reviewBar() + '<table class="g-table"><thead><tr>' +
      '<th>שם</th><th>טלפון</th><th>מקצוע</th><th>מצב</th><th>ענה</th><th>נשאר</th><th>ציון</th><th>מאנדיי</th><th>פעולות</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (c) {
        return '<tr class="clickable" data-open="' + esc(c.code) + '">' +
          '<td><b>' + esc(c.name) + '</b>' + (c.review ? ' <span class="g-pill mid">בדיקה</span>' : '') + '</td>' +
          '<td class="g-num">' + esc(c.phone) + '</td>' +
          '<td>' + esc(c.subject_name || '—') + '</td>' +
          '<td>' + statusPill(c) + '</td>' +
          '<td class="g-num">' + c.answered + ' / ' + c.total + '</td>' +
          '<td class="g-num">' + (c.status === 'running' ? mins(c.remaining_sec) : '—') +
            (c.extra_sec ? ' <span class="g-pill mid">+' + Math.round(c.extra_sec / 60) + '</span>' : '') + '</td>' +
          '<td class="g-num">' + (c.total_score != null ? ('<b>' + c.total_score + '</b> / 24') : (c.status === 'submitted' ? '<span class="g-pill mid">לבדיקה</span>' : '—')) + '</td>' +
          '<td>' + (c.monday_item_id ? '<span class="g-pill good">נשלח</span>' : '—') + '</td>' +
          '<td><div class="g-act">' +
            (c.status === 'running'
              ? '<button class="g-btn" data-act="pause" data-c="' + esc(c.code) + '">' + (c.paused ? 'המשך' : 'השהה') + '</button>' +
                '<button class="g-btn" data-act="extra" data-c="' + esc(c.code) + '">+5 דק׳</button>'
              : '') +
            (c.status === 'running' ? '<button class="g-btn" data-act="finish" data-c="' + esc(c.code) + '" title="מה שנשמר עד עכשיו הוא התשובה">סיים</button>' : '') +
            (c.status === 'submitted' ? '<button class="g-btn" data-act="reopen" data-c="' + esc(c.code) + '" title="חוזר למצב מבחן, +5 דק׳, כל התשובות נשמרות">פתח מחדש</button>' : '') +
            '<button class="g-btn danger" data-act="reset" data-c="' + esc(c.code) + '">איפוס</button>' +
            '<button class="g-btn danger" data-act="delete" data-c="' + esc(c.code) + '">מחק</button>' +
          '</div></td></tr>';
      }).join('') + '</tbody></table>';
  }

  function wirePeople() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-rev]'), function (b) {
      b.onclick = function () {
        b.disabled = true;
        api('/api/examiner/teach/review-open', { subject_id: b.getAttribute('data-rev') })
          .then(function (r) { window.open(r.url, '_blank'); b.disabled = false; refresh(); })
          .catch(function (e) { alert(e.message); b.disabled = false; });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-act]'), function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var act = b.getAttribute('data-act'), code = b.getAttribute('data-c');
        if (act === 'reset' && !confirm('לאפס את המבחן של המועמד? כל התשובות יימחקו ואי אפשר לשחזר.')) return;
        if (act === 'delete' && !confirm('למחוק את המועמד לגמרי, כולל התשובות והציונים? אי אפשר לשחזר.')) return;
        if (act === 'finish' && !confirm('לסיים את המבחן עכשיו? מה שנשמר עד כה ייחשב כתשובה.')) return;
        var url = { pause: '/api/examiner/teach/pause', extra: '/api/examiner/teach/extra-time', reset: '/api/examiner/teach/reset',
                    'delete': '/api/examiner/teach/delete', finish: '/api/examiner/teach/force-submit', reopen: '/api/examiner/teach/reopen' }[act];
        api(url, act === 'extra' ? { code: code, minutes: 5 } : { code: code }).then(refresh).catch(function (e) { alert(e.message); });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-open]'), function (tr) {
      tr.onclick = function () { openCard(tr.getAttribute('data-open')); };
    });
  }

  // ------------------------------------------------------------- כרטיס מועמד
  // after — הודעה שמוצגת *אחרי* הרינדור (הודעה שנכתבת לפני openCard נמחקת ברינדור מחדש)
  function openCard(code, after) {
    api('/api/examiner/teach/candidate/' + encodeURIComponent(code)).then(function (r) {
      S.card = r; S.open = code; render();
      if (typeof after === 'function') after();
    });
  }

  // ניקוד מכני של מסלול השיחה: מוצאים כל מהלך בעץ המנוקד ומסכמים
  function scorePath(tree, path) {
    if (!tree || !path || !path.length) return { pts: [], total: 0, max: 6 };
    var pts = [];
    var n1 = tree.t1, o1 = n1.opts.filter(function (o) { return o.id === path[0].id; })[0];
    pts.push(o1 ? o1.score : 0);
    if (path[1]) {
      var n2 = tree.t2[path[0].to] || {}, o2 = (n2.opts || []).filter(function (o) { return o.id === path[1].id; })[0];
      pts.push(o2 ? o2.score : 0);
    }
    if (path[2]) {
      var n3 = tree.t3[path[1].to] || tree.t3.stuck, o3 = (n3.opts || []).filter(function (o) { return o.id === path[2].id; })[0];
      pts.push(o3 ? o3.score : 0);
    }
    return { pts: pts, total: pts.reduce(function (a, b) { return a + b; }, 0), max: 6 };
  }
  function scorePill(n) {
    return '<span class="g-score s' + n + '">' + n + '</span>';
  }

  function side(cls, label, html) {
    return '<div class="g-side ' + cls + '"><div class="lbl">' + esc(label) + '</div>' +
           (html ? '<p>' + html + '</p>' : '<p class="none">לא נענה</p>') + '</div>';
  }

  function qBlock(id, name, timeSec, inner) {
    return '<div class="g-qblock" data-q="' + esc(id) + '"><div class="g-qhead">' +
             '<span class="qid">' + esc(id.toUpperCase()) + '</span>' +
             '<span class="qname">' + esc(name) + '</span>' +
             '<span class="qtime">' + (timeSec != null ? mins(timeSec) : '—') + '</span>' +
           '</div><div class="g-qbody">' + inner + '</div></div>';
  }

  function cardHtml() {
    var d = S.card, c = d.candidate, K = d.key, A = d.answers, ex = d.exam;
    if (!ex || !K) return '<div class="g-empty">המועמד עדיין לא בחר מקצוע.<button class="g-btn" id="g-back" style="margin-right:12px">חזרה</button></div>';
    var q = {}; ex.questions.forEach(function (x) { q[x.id] = x; });
    var out = '';

    out += '<div class="g-card"><div class="g-card-top">' +
      '<span class="nm">' + esc(c.name) + '</span>' +
      '<span class="meta">' + esc(K.subject_name) + ' · ' + esc(c.phone) + ' · זמן כולל ' + mins(c.used_sec) + '</span>' +
      '<span class="spacer" style="flex:1"></span>' +
      '<button class="g-btn" id="g-back">חזרה לרשימה</button></div>' +
      '<div class="g-card-body">';

    // ---- שאלה 1: השלב השבור + התיקון
    var a1 = (A.q1 && A.q1.value) || {};
    var stepsHtml = (q.q1.steps || []).map(function (s, i) {
      var n = i + 1;
      var isBroken = n === K.q1.broken_step, isPicked = n === a1.step;
      var cls = isBroken ? 'broken' : (isPicked ? 'wrong' : '');
      var tag = isBroken && isPicked ? 'נכון ✓' : isBroken ? 'השלב השבור' : isPicked ? 'הוא סימן' : '';
      return '<div class="g-strow ' + cls + '"><span class="n">' + n + '</span>' +
             '<span class="' + (q.q1.steps_ltr ? 'ltr' : '') + '">' + mt(s) + '</span>' +
             '<span class="tag">' + esc(tag) + '</span></div>';
    }).join('');
    var autoTag = d.auto && d.auto.step_ok ? '<span class="g-pill good">מצא את השלב</span>' : '<span class="g-pill bad">לא מצא את השלב</span>';
    if (d.auto && d.auto.ans_ok === true) autoTag += ' <span class="g-pill good">תשובה נכונה</span>';
    if (d.auto && d.auto.ans_ok === false) autoTag += ' <span class="g-pill bad">תשובה שגויה</span>';
    if (d.auto && d.auto.ans_ok === null) autoTag += ' <span class="g-pill mid">התיקון — לשיפוטך</span>';

    out += qBlock('q1', 'ידע ואבחון — איתור השלב השבור', A.q1 && A.q1.time_spent_sec,
      '<div style="margin-bottom:10px">' + autoTag + '</div>' +
      '<div class="g-steps">' + stepsHtml + '</div>' +
      '<div class="g-two">' +
        side('ans', 'התיקון שהוא כתב', a1.text ? ('<span class="' + (K.q1.fix_ltr ? 'ltr' : '') + '">' + esc(a1.text) + '</span>') : '') +
        side('key', 'התיקון הנכון', '<span class="' + (K.q1.fix_ltr ? 'ltr' : '') + '">' + mt(K.q1.fix) + '</span>') +
      '</div>');

    // ---- שאלה 2: אבחון
    out += qBlock('q2', 'מה הוא לא הבין, ומה יגיד לו', A.q2 && A.q2.time_spent_sec,
      '<div class="g-two">' +
        side('ans', 'התשובה שלו', ((A.q2 && A.q2.value && A.q2.value.text) ? esc(A.q2.value.text) : '')) +
        side('key', 'תשובה חזקה נשמעת כך', esc(K.q2.strong)) +
      '</div>' +
      '<div class="g-side flag" style="margin-top:12px"><div class="lbl">הדגל האדום</div><p>' + esc(K.q2.weak) + '</p></div>');

    // ---- שאלה 3: כיול
    out += qBlock('q3', 'מה בהסבר של ה-AI לא יעבוד לתלמידה', A.q3 && A.q3.time_spent_sec,
      side('ans', 'התשובה שלו', ((A.q3 && A.q3.value && A.q3.value.text) ? esc(A.q3.value.text) : '')) +
      '<div class="g-two" style="margin-top:12px">' +
        side('key', 'מה מורידים', esc(K.q3.drop)) +
        side('key', 'במה פותחים', esc(K.q3.open)) +
      '</div>' +
      '<div class="g-side key" style="margin-top:12px"><div class="lbl">ובאיזה משפט מסיימים</div><p>' + esc(K.q3.close) + '</p></div>' +
      '<p class="g-note"><b>הדגל:</b> מי שמשאיר את הכלל בפתיחה, או שרק «מפשט» את הניסוח בלי לשנות את הסדר — לא הבין את השאלה.</p>');

    // ---- שאלה 4: מערכי שיעור
    var a4 = (A.q4 && A.q4.value) || {};
    var plans = K.q4.map(function (p) {
      return '<div class="g-plan' + (a4.plan === p.id ? ' chosen' : '') + '">' +
        '<span class="pn">' + esc(p.name) + (a4.plan === p.id ? '  ← בחר בזה' : '') + '</span>' +
        '<span class="pro"><b>היתרון:</b> ' + esc(p.pro) + '</span>' +
        '<span class="con"><b>המחיר:</b> ' + esc(p.con) + '</span></div>';
    }).join('');
    out += qBlock('q4', 'בחירת מערך שיעור והמחיר שלה', A.q4 && A.q4.time_spent_sec,
      plans + '<div style="margin-top:12px">' +
      side('ans', 'הנימוק שלו', (a4.text ? esc(a4.text) : '')) + '</div>' +
      '<p class="g-note">מחפשים שהוא זיהה את <b>המחיר האמיתי</b> של המערך שבחר. מי שכתב רק יתרונות — לא באמת בחר.</p>');

    // ---- שאלה 5: השיחה
    var a5 = (A.q5 && A.q5.value) || {};
    var sc = scorePath(K.sim_tree, a5.path || []);
    var convo = (a5.path || []).map(function (t, i) {
      return '<div class="g-turn you"><span class="who">הוא · מהלך ' + (i + 1) + '</span>' +
               (sc.pts[i] != null ? scorePill(sc.pts[i]) : '') + mt(t.label) + '</div>' +
             '<div class="g-turn her"><span class="who">התלמידה</span>' + mt(t.reply) + '</div>';
    }).join('') || '<p class="none" style="color:var(--faint)">לא ניהל שיחה</p>';
    var scoreLine = (a5.path && a5.path.length)
      ? '<div class="g-scoreline">ניקוד המהלכים: <b>' + sc.total + ' / ' + sc.max + '</b>' +
        ' <span class="g-note" style="margin:0">(' + sc.pts.join(' + ') + ')</span>' +
        ' · הניתוח העצמי: <b>עד 3</b> לפי הרובריקה מטה</div>'
      : '';
    var simKey = K.q5.map(function (k) {
      return '<div class="g-two" style="margin-bottom:10px">' +
        side('key', k.look, esc(k.good)) + side('flag', 'הדגל', esc(k.flag)) + '</div>';
    }).join('');
    var rr = ((K.sim_tree && K.sim_tree.scoring && K.sim_tree.scoring.reflect_rubric) || []).map(function (r) {
      return '<div class="g-rrow"><span class="g-score s' + r.pts + '">' + r.pts + '</span><span>' + esc(r.text) + '</span></div>';
    }).join('');
    out += qBlock('q5', 'השיחה מול התלמידה', A.q5 && A.q5.time_spent_sec,
      scoreLine + '<div class="g-convo">' + convo + '</div>' +
      (rr ? '<div class="g-cap">רובריקת הניתוח העצמי — נקודה לכל שורה</div><div class="g-rubric">' + rr + '</div>' : '') +
      '<div style="margin-top:14px">' + side('ans', 'הניתוח העצמי שלו', (a5.text ? esc(a5.text) : '')) + '</div>' +
      '<p class="g-note" style="margin-bottom:10px"><b>לא מנקדים איזה מסלול בחר — מנקדים לאן הוא הוביל.</b></p>' + simKey);

    // ---- שאלה 6: שיקול דעת
    var a6 = (A.q6 && A.q6.value) || {};
    var vmap = {}; K.q6.verdicts.forEach(function (v) { vmap[v.id] = v.verdict; });
    var opts6 = (q.q6.opts || []).map(function (o) {
      var v = vmap[o.id];
      var pill = v === 'good' ? '<span class="g-pill good">סביר</span>'
        : v === 'weak' ? '<span class="g-pill mid">חלש</span>' : '<span class="g-pill bad">נפילה</span>';
      return '<div class="g-strow ' + (a6.pick === o.id ? 'picked' : '') + '">' +
        '<span class="n">' + esc(o.id) + '</span><span>' + esc(o.text) + (a6.pick === o.id ? '  ← בחר' : '') + '</span>' +
        '<span class="tag">' + pill + '</span></div>';
    }).join('');
    out += qBlock('q6', 'שיקול דעת — תשובה נכונה בלי הבנה', A.q6 && A.q6.time_spent_sec,
      '<div class="g-steps">' + opts6 + '</div>' +
      side('ans', 'הנימוק שלו', (a6.text ? esc(a6.text) : '')) +
      '<div class="g-side key" style="margin-top:12px"><div class="lbl">הנימוק חייב לכלול</div><p>' + esc(K.q6.must) + '</p></div>');

    out += '</div></div>';
    return out;
  }

  // ------------------------------------------------------------- בדיקה: רובריקה, AI, ציון, מאנדיי
  var saveT = {};
  function autoLabel(qid, k, v, q) {
    if (qid === 'q1' && k === 'step') return 'זיהה את השלב השבור · ' + v + '/1';
    if (qid === 'q1' && k === 'fix')  return 'התיקון · ' + v + '/1' + (q.rubric.fix_correct === undefined ? ' (אוטומטי)' : '');
    if (qid === 'q5' && k === 'moves') return 'מהלכי השיחה · ' + v + '/6 (אוטומטי)';
    if (qid === 'q6' && k === 'pick')  return 'הבחירה · ' + v + '/2 (אוטומטי)';
    return k + ' · ' + v;
  }
  function gradingHtml(qid) {
    var d = S.card, sc = d.score && d.score.questions[qid], model = (d.scoring && d.scoring.scoring[qid]) || {};
    var labels = (d.scoring && d.scoring.labels) || {};
    var g = (d.grades && d.grades[qid]) || { scores: {}, comment: '' };
    var ai = g.ai || null;
    if (!sc) return '';
    var h = '<div class="g-grade">' +
      '<div class="g-grade-h"><span>בדיקה</span><b class="g-qpts" data-pts="' + qid + '">' + sc.points + ' / ' + sc.max + '</b></div>';
    // חלקים אוטומטיים
    var autos = Object.keys(sc.auto).filter(function (k) { return k !== 'moves_pts'; });
    if (autos.length) h += '<div class="g-autos">' + autos.map(function (k) {
      if (qid === 'q1' && k === 'fix' && (model.rubric || []).length === 0 && sc.rubric.fix_correct === undefined && d.key.q1.ans_type !== 'num') return '';
      if (qid === 'q1' && k === 'fix' && d.key.q1.ans_type !== 'num') return '';   // מסומן ברובריקה למטה
      return '<span class="g-pill ' + (sc.auto[k] > 0 ? 'good' : 'bad') + '">' + esc(autoLabel(qid, k, sc.auto[k], sc)) + '</span>';
    }).join(' ') + '</div>';
    // רובריקה
    var crits = (model.rubric || []).slice();
    if (qid === 'q1' && d.key.q1.ans_type !== 'num') crits.unshift('fix_correct');
    if (crits.length) {
      h += '<div class="g-rub">' + crits.map(function (c) {
        var v = g.scores[c]; var a = ai && ai.criteria && ai.criteria[c];
        return '<label class="g-rrow2">' +
          '<input type="checkbox" data-crit="' + esc(c) + '" data-q="' + esc(qid) + '"' + (v ? ' checked' : '') + '>' +
          '<span class="g-rlabel">' + esc(labels[c] || c) + '</span>' +
          (a ? '<span class="g-aihint ' + (a.met ? 'yes' : 'no') + '" title="' + esc(a.evidence || '') + '">AI: ' + (a.met ? '✓' : '✗') +
               (a.evidence ? ' «' + esc(a.evidence.slice(0, 60)) + '»' : '') + '</span>' : '') +
          '</label>';
      }).join('') + '</div>';
    }
    if (ai && ai.conclusion) h += '<div class="g-aiconc' + (ai.demo ? ' demo' : '') + '">' + (ai.demo ? 'הדגמה · ' : 'AI · ') + esc(ai.conclusion) + '</div>';
    h += '<textarea class="g-comment" data-q="' + esc(qid) + '" placeholder="הערת בודק (תופיע בסיכום למאנדיי)">' + esc(g.comment || '') + '</textarea>' +
      '</div>';
    return h;
  }

  function scoreBarHtml() {
    var d = S.card, sc = d.score; if (!sc) return '';
    var missing = Object.keys(sc.questions).filter(function (q) { return sc.questions[q].complete === false; }).length;
    var m = d.monday || {};
    return '<div class="g-scorebar">' +
      '<div class="g-total"><span>ציון</span><b id="g-total">' + sc.total + '</b><span>/ ' + sc.max + '</span>' +
        '<span class="g-miss" id="g-miss">' + (sc.complete ? 'הבדיקה הושלמה' : ('חסר סימון ב-' + missing + ' שאלות')) + '</span></div>' +
      '<div class="g-act">' +
        '<button class="g-btn" id="g-ai" title="ממלא הצעה לכל שורה ברובריקה. מה שסימנת בעצמך לא משתנה.">' + (d.ai_available ? 'בדוק עם AI' : 'בדוק עם AI (הדגמה)') + '</button>' +
        (m.fixed_board
          ? '<button class="g-btn rev" id="g-monday-quick" title="מוצא את השורה של המועמד בבורד לפי שם ומעדכן את העמודות «ציון מבחן» ו«הערכה מילולית»">' +
              (m.item_id ? 'עדכן במאנדיי' : 'שלח למאנדיי') + ' · ' + esc(m.fixed_board_name || ('בורד ' + m.fixed_board)) + '</button>' +
            '<button class="g-btn" id="g-monday">שנה בורד / מיפוי</button>'
          : '<button class="g-btn rev" id="g-monday">' + (m.item_id ? 'עדכן במאנדיי' : 'שלח למאנדיי') + '</button>') +
        (m.item_id ? '<span class="g-pill good" title="פריט ' + esc(m.item_id) + '">נשלח · ' + esc(m.item_name || ('פריט ' + m.item_id)) + '</span>' : '') +
      '</div>' +
      '<div id="g-mpick" hidden></div>' +
      '<div id="g-mpanel" hidden></div>' +
      '<div class="g-note" id="g-msg" style="margin:6px 0 0"></div>' +
    '</div>';
  }

  function eventsHtml() {
    var ev = (S.card && S.card.events) || [];
    if (!ev.length) return '';
    var names = { login: 'כניסה', start: 'התחלה', submit: 'הגשה', admin: 'מנהל', grade: 'סימון בודק', ai_grade: 'בדיקת AI', monday: 'מאנדיי', question: 'שאלה' };
    return '<div class="g-qblock"><div class="g-qhead"><span class="qid">יומן</span><span class="qname">מה קרה ומתי</span></div>' +
      '<div class="g-qbody"><div class="g-events">' + ev.map(function (e) {
        var d = new Date(e.at); var hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');
        return '<div class="g-ev"><span class="g-evt">' + dd + ' ' + hh + '</span><span class="g-evk">' + esc(names[e.kind] || e.kind) + '</span><span>' + esc(e.detail || '') + '</span></div>';
      }).join('') + '</div></div></div>';
  }

  function mountGrading() {
    var d = S.card; if (!d || !d.score) return;
    var reopened = d.reopened || [];
    Array.prototype.forEach.call(document.querySelectorAll('.g-qblock[data-q]'), function (blk) {
      var qid = blk.getAttribute('data-q'); var body = blk.querySelector('.g-qbody'); var head = blk.querySelector('.g-qhead');
      if (head && !head.querySelector('[data-reopen]')) {
        head.insertAdjacentHTML('beforeend', reopened.indexOf(qid) >= 0
          ? '<span class="g-pill mid" style="margin-inline-start:8px">פתוחה לעריכה</span>'
          : '<button class="g-btn" data-reopen="' + esc(qid) + '" style="margin-inline-start:8px" title="המועמד יוכל לערוך את השאלה הזו שוב. אם המבחן הוגש — הוא נפתח מחדש עם 5 דק׳.">פתח שאלה מחדש</button>');
      }
      if (body && !blk.querySelector('.g-grade')) body.insertAdjacentHTML('beforeend', gradingHtml(qid));
    });
    var cardBody = document.querySelector('.g-card-body');
    if (cardBody && !document.querySelector('.g-events')) cardBody.insertAdjacentHTML('beforeend', eventsHtml());
    Array.prototype.forEach.call(document.querySelectorAll('[data-reopen]'), function (b) {
      b.onclick = function () {
        if (!confirm('לפתוח את השאלה הזו מחדש לעריכה אצל המועמד?')) return;
        api('/api/examiner/teach/reopen', { code: S.open, qid: b.getAttribute('data-reopen') }).then(function () { openCard(S.open); }).catch(function (e) { alert(e.message); });
      };
    });
    var top = document.querySelector('.g-card-body');
    if (top && !document.querySelector('.g-scorebar')) top.insertAdjacentHTML('afterbegin', scoreBarHtml());
    wireGrading();
  }

  function collect(qid) {
    var scores = {};
    Array.prototype.forEach.call(document.querySelectorAll('input[data-crit][data-q="' + qid + '"]'), function (cb) {
      scores[cb.getAttribute('data-crit')] = cb.checked ? 1 : 0;
    });
    var ta = document.querySelector('textarea.g-comment[data-q="' + qid + '"]');
    return { scores: scores, comment: ta ? ta.value : '' };
  }
  function pushGrade(qid) {
    var body = collect(qid);
    api('/api/examiner/teach/grade', { code: S.open, qid: qid, scores: body.scores, comment: body.comment })
      .then(function (r) { S.card.score = r.score; S.card.grades = r.grades; paintScores(); })
      .catch(function (e) { msg(e.message, true); });
  }
  function paintScores() {
    var sc = S.card.score; if (!sc) return;
    Array.prototype.forEach.call(document.querySelectorAll('.g-qpts'), function (el) {
      var q = sc.questions[el.getAttribute('data-pts')]; if (q) el.textContent = q.points + ' / ' + q.max;
    });
    var t = document.getElementById('g-total'); if (t) t.textContent = sc.total;
    var missing = Object.keys(sc.questions).filter(function (q) { return sc.questions[q].complete === false; }).length;
    var mm = document.getElementById('g-miss'); if (mm) mm.textContent = sc.complete ? 'הבדיקה הושלמה' : ('חסר סימון ב-' + missing + ' שאלות');
  }
  function msg(t, bad) { var m = document.getElementById('g-msg'); if (m) { m.textContent = t || ''; m.style.color = bad ? 'var(--danger)' : 'var(--muted)'; } }

  function wireGrading() {
    Array.prototype.forEach.call(document.querySelectorAll('input[data-crit]'), function (cb) {
      cb.onchange = function () { pushGrade(cb.getAttribute('data-q')); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('textarea.g-comment'), function (ta) {
      ta.oninput = function () {
        var q = ta.getAttribute('data-q'); if (saveT[q]) clearTimeout(saveT[q]);
        saveT[q] = setTimeout(function () { pushGrade(q); }, 800);
      };
    });
    var ai = document.getElementById('g-ai');
    if (ai) ai.onclick = function () {
      ai.disabled = true; msg('ה-AI בודק… (כ-10–40 שניות)');
      api('/api/examiner/teach/ai-grade', { code: S.open }).then(function (r) {
        var t = r.demo ? 'רץ במצב הדגמה — אין מפתח API בשרת. הסימונים לפי אורך בלבד.' : 'ה-AI סיים. הסימונים שלו מופיעים ליד כל שורה; מה שסימנת בעצמך נשאר.';
        openCard(S.open, function () { msg(t); });
      }).catch(function (e) { msg(e.message, true); ai.disabled = false; });
    };
    var mb = document.getElementById('g-monday');
    if (mb) mb.onclick = function () { toggleMonday(); };
    var mq = document.getElementById('g-monday-quick');
    if (mq) mq.onclick = function () {
      var m = S.card.monday;
      sendMonday({ code: S.open, board_id: m.fixed_board, board_name: m.fixed_board_name }, mq);
    };
  }

  // ---------- מאנדיי: שליחה + בחירת שורה כשאין שם זהה ----------
  function sendMonday(body, btn) {
    if (btn) btn.disabled = true;
    var pick = document.getElementById('g-mpick'); if (pick) { pick.hidden = true; pick.innerHTML = ''; }
    msg('שולח למאנדיי…');
    api('/api/examiner/teach/monday/send', body).then(function (r) {
      var t = (r.created ? 'נוצרה שורה חדשה «' : 'עודכנה השורה «') + (r.item_name || r.item_id) + '» בבורד «' + (r.board_name || '') + '» · ' + r.sent + ' עמודות.';
      openCard(S.open, function () { msg(t); });
    }).catch(function (e) {
      if (btn) btn.disabled = false;
      if (e.status === 409 && e.data && e.data.needs_pick) return showPick(e.data, body);
      msg(e.message, true);
    });
  }
  function showPick(d, body) {
    var pick = document.getElementById('g-mpick'); if (!pick) return msg(d.error, true);
    msg('');
    var sugg = d.suggestions || [];
    pick.hidden = false;
    pick.innerHTML = '<div class="g-pick">' +
      '<div class="g-pick-h">' + esc(d.error) + '</div>' +
      (sugg.length ? '<div class="g-pick-list">' + sugg.map(function (s) {
        return '<button class="g-btn" data-pick="' + esc(s.id) + '" data-name="' + esc(s.name) + '" title="' + esc(s.reason || '') + '">' +
          esc(s.name) + ' <span class="g-pick-why">' + esc(s.reason || '') + '</span></button>';
      }).join('') + '</div>' : '') +
      '<div class="g-pick-foot">' +
        '<button class="g-btn" id="g-pick-new">צור שורה חדשה בשם «' + esc(d.candidate) + '»</button>' +
        '<button class="g-btn ghost" id="g-pick-cancel">בטל</button>' +
      '</div></div>';
    Array.prototype.forEach.call(pick.querySelectorAll('[data-pick]'), function (b) {
      b.onclick = function () {
        if (!confirm('לעדכן את השורה «' + b.getAttribute('data-name') + '» בציון של ' + d.candidate + '?')) return;
        sendMonday(Object.assign({}, body, { item_id: b.getAttribute('data-pick'), item_name: b.getAttribute('data-name') }), null);
      };
    });
    var nb = document.getElementById('g-pick-new');
    if (nb) nb.onclick = function () { sendMonday(Object.assign({}, body, { create_new: true }), nb); };
    var cb = document.getElementById('g-pick-cancel');
    if (cb) cb.onclick = function () { pick.hidden = true; pick.innerHTML = ''; };
  }

  // ---------- מאנדיי: בחירת בורד ומיפוי עמודות ----------
  var M = { boards: null, cols: null, setup: null };
  function guessCol(fieldId, cols) {
    var pats = {
      first: /שם פרטי|first/i, last: /שם משפחה|last|משפחה/i,
      phone: /טלפון|phone|נייד|mobile/i, subject: /מקצוע|subject/i, total: /ציון מבחן|^ציון$|ציון \(|score|total|נקודות/i,
      percent: /אחוז|percent|%/i, date: /תאריך|date/i, verbal: /הערכה מילולית|מילולי|verbal/i,
      summary: /סיכום|הערות|notes|summary|comment|משוב/i
    };
    var re = pats[fieldId]; if (!re) return '';
    var byType = { percent: 'numbers', date: 'date', summary: 'long_text' };
    var c = cols.filter(function (x) { return re.test(x.title) && (!byType[fieldId] || x.type === byType[fieldId] || x.type === 'text'); })[0];
    return c ? c.id : '';
  }
  function toggleMonday() {
    var p = document.getElementById('g-mpanel'); if (!p) return;
    if (!p.hidden) { p.hidden = true; return; }
    p.hidden = false; p.innerHTML = '<div class="g-note">טוען בורדים…</div>';
    Promise.all([ api('/api/examiner/monday/boards'), api('/api/examiner/teach/monday/setup') ]).then(function (rs) {
      M.boards = rs[0].boards || []; M.setup = rs[1];
      if (!M.setup.has_token) { p.innerHTML = '<div class="g-note" style="color:var(--danger)">אין טוקן של מאנדיי בשרת (MONDAY_API_TOKEN).</div>'; return; }
      var cur = (S.card.monday && S.card.monday.board_id) || M.setup.board_id || (M.boards[0] && M.boards[0].id);
      p.innerHTML = '<div class="g-mrow"><label>בורד</label><select id="g-board">' + M.boards.map(function (b) {
        return '<option value="' + esc(b.id) + '"' + (String(b.id) === String(cur) ? ' selected' : '') + '>' + esc(b.name) + ' (' + b.items + ')</option>';
      }).join('') + '</select></div><div id="g-map"><div class="g-note">טוען עמודות…</div></div>';
      document.getElementById('g-board').onchange = loadCols; loadCols();
    }).catch(function (e) { p.innerHTML = '<div class="g-note" style="color:var(--danger)">' + esc(e.message) + '</div>'; });
  }
  function loadCols() {
    var board = document.getElementById('g-board').value; var map = document.getElementById('g-map');
    map.innerHTML = '<div class="g-note">טוען עמודות…</div>';
    Promise.all([ api('/api/examiner/monday/board/' + encodeURIComponent(board)), api('/api/examiner/teach/monday/setup') ]).then(function (rs) {
      var cols = rs[0].columns || []; var saved = (rs[1].board_id === board && rs[1].mapping) ? rs[1].mapping : null;
      // date נכתב גם לעמודת date
      M.cols = cols;
      map.innerHTML = M.setup.fields.map(function (f) {
        var sel = saved ? (saved[f.id] || '') : guessCol(f.id, cols);
        return '<div class="g-mrow"><label>' + esc(f.label) + '</label><select data-f="' + esc(f.id) + '"><option value="">— לא לשלוח —</option>' +
          cols.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(c.title) + ' · ' + esc(c.type) + '</option>'; }).join('') +
          '</select></div>';
      }).join('') +
      '<div class="g-note">השורה נמצאת לפי שם המועמד (אם אין שם זהה — תתבקש לבחור). נשלח רק מה שמופה; עמודה שלא מופתה לא נגעת.</div>' +
      '<button class="g-btn rev" id="g-msend">' + ((S.card.monday && S.card.monday.item_id) ? 'עדכן את הפריט' : 'צור פריט ושלח') + '</button>';
      document.getElementById('g-msend').onclick = function () {
        var mapping = {}; Array.prototype.forEach.call(map.querySelectorAll('select[data-f]'), function (s) { if (s.value) mapping[s.getAttribute('data-f')] = s.value; });
        if (!Object.keys(mapping).length) { msg('לא מופתה אף עמודה.', true); return; }
        var bname = (M.boards.filter(function (x) { return String(x.id) === String(board); })[0] || {}).name || '';
        sendMonday({ code: S.open, board_id: board, board_name: bname, mapping: mapping }, this);
      };
    }).catch(function (e) { map.innerHTML = '<div class="g-note" style="color:var(--danger)">' + esc(e.message) + '</div>'; });
  }

  // ------------------------------------------------------------- מפתח הבדיקה
  // כל שאלה במלואה — בדיוק כמו שהמועמד רואה אותה — ומתחתיה המפתח שלה.
  function keyHtml() {
    var K = S.key;
    if (!K || !K.exam) return '<div class="g-empty">טוען…</div>';
    var q = {}; K.exam.questions.forEach(function (x) { q[x.id] = x; });
    var subs = (S.list && S.list.subjects) || [];
    var out = '<div class="g-tabs" id="g-subs">' + subs.map(function (x) {
      return '<button class="g-tab' + (S.subject === x.id ? ' sel' : '') + '" data-k="' + esc(x.id) + '">' + esc(x.name) + '</button>';
    }).join('') + '</div>';

    out += '<div class="g-note" style="margin:0 0 6px"><b>' + esc(K.exam.exam) + '</b> · ' +
           esc(K.exam.topic) + ' · ' + Math.round(K.exam.duration_sec / 60) + ' דקות</div>' +
           (K.syllabus ? '<div class="g-syll"><span>בסילבוס:</span> ' + esc(K.syllabus) + '</div>' : '');

    // ---------- שאלה 1 ----------
    var q1 = q.q1;
    var brief = (q1.brief_kind === 'math')
      ? '<div class="t-source t-math">' + mt(q1.brief_body) + '</div>'
      : '<div class="g-cap">' + esc(q1.brief_label) + '</div>' +
        '<div class="t-source' + (q1.brief_ltr ? ' ltr' : '') + '">' + mt(q1.brief_body) + '</div>';
    var steps = q1.steps.map(function (t, i) {
      var n = i + 1, broken = n === K.q1.broken_step;
      return '<div class="g-strow ' + (broken ? 'broken' : '') + '"><span class="n">' + n + '</span>' +
             '<span class="' + (q1.steps_ltr ? 'ltr' : '') + '">' + mt(t) + '</span>' +
             '<span class="tag">' + (broken ? 'השלב השבור' : '') + '</span></div>';
    }).join('');
    out += qBlock('q1', 'ידע ואבחון', null,
      '<p class="g-q">' + mt(q1.stem) + '</p>' +
      '<p class="g-brief">' + mt(q1.brief_he) + '</p>' + brief +
      '<div class="g-cap">' + esc(q1.steps_label) + '</div>' +
      '<div class="g-steps">' + steps + '</div>' +
      '<p class="g-ask">' + mt(q1.ask) + '</p>' +
      '<div class="g-side key"><div class="lbl">התיקון הנכון</div><p class="' + (K.q1.fix_ltr ? 'ltr' : '') + '">' + mt(K.q1.fix) + '</p></div>' +
      (K.q1.ans_type === 'num'
        ? '<p class="g-note">המערכת מקבלת אוטומטית: <b>' + K.q1.accepts.map(esc).join('</b> · <b>') + '</b></p>'
        : '<p class="g-note">שאלה רבת-מלל — אין תשובה אחת, ההשוואה לפי המשמעות.</p>'));

    // ---------- שאלה 2 ----------
    out += qBlock('q2', 'אבחון וניסוח', null,
      '<p class="g-q">' + mt(q.q2.stem) + '</p>' +
      '<p class="g-ask">' + mt(q.q2.ask) + '</p>' +
      '<p class="g-note" style="margin-top:0">המועמד רואה שוב את הפתרון של התלמיד בלחיצה על «הצג שוב».</p>' +
      '<div class="g-two" style="margin-top:12px">' +
        side('key', 'תשובה חזקה', esc(K.q2.strong)) + side('flag', 'תשובה חלשה', esc(K.q2.weak)) + '</div>');

    // ---------- שאלה 3 ----------
    out += qBlock('q3', 'כיול לתלמיד', null,
      '<p class="g-q">' + mt(q.q3.stem) + '</p>' +
      '<div class="t-profile">' + esc(q.q3.profile) + '</div>' +
      '<div class="g-cap">ההסבר שנכתב ע״י AI — נכון לחלוטין</div>' +
      '<div class="t-ai' + (q.q3.ai_ltr ? ' ltr' : '') + '">' + esc(q.q3.ai) + '</div>' +
      '<p class="g-ask">' + mt(q.q3.ask) + '</p>' +
      '<div class="g-two">' + side('key', 'מה מורידים', esc(K.q3.drop)) + side('key', 'במה פותחים', esc(K.q3.open)) + '</div>' +
      '<div class="g-side key" style="margin-top:12px"><div class="lbl">ובאיזה משפט מסיימים</div><p>' + esc(K.q3.close) + '</p></div>' +
      '<p class="g-note"><b>נקודת תשומת הלב:</b> ההסבר עונה על שאלה <b>אחרת</b> מזו שהתלמידה שאלה. ' +
      'מורה שם לב לזה בשנייה. מי שכתב «ההסבר נכון אבל מסובך» או «צריך לפשט» — קרא אותו כטקסט, לא כתשובה לתלמידה שלפניו.</p>');

    // ---------- שאלה 4 ----------
    var kp = {}; K.q4.forEach(function (x) { kp[x.id] = x; });
    var plans = q.q4.plans.map(function (p) {
      var beats = p.beats.map(function (b) {
        return '<div class="g-beat"><span class="bt">' + esc(b[0]) + '</span><span>' + esc(b[1]) + '</span></div>';
      }).join('');
      var k = kp[p.id] || {};
      return '<div class="g-plan"><span class="pn">' + esc(p.name) + '</span>' + beats +
        '<span class="pro" style="margin-top:8px"><b>היתרון האמיתי:</b> ' + esc(k.pro || '') + '</span>' +
        '<span class="con"><b>המחיר האמיתי:</b> ' + esc(k.con || '') + '</span></div>';
    }).join('');
    out += qBlock('q4', 'בניית שיעור', null,
      '<p class="g-q">' + mt(q.q4.stem) + '</p>' + plans +
      '<p class="g-ask">' + mt(q.q4.ask) + '</p>');

    // ---------- שאלה 5: תרשים זרימה ----------
    var sim = q.q5, ST = sim.states || {};
    function stBadge(id) {
      var st = ST[id] || { name: id };
      return '<span class="g-state s-' + esc(id) + '">' + esc(st.name) + '</span>';
    }
    var TREE = K.sim_tree || sim;
    function findScore(nodeOpts, id) {
      var m = (nodeOpts || []).filter(function (o) { return o.id === id; })[0];
      return m && m.score != null ? m.score : null;
    }
    function optRow(o, showTarget, scoredOpts) {
      var sc = findScore(scoredOpts, o.id);
      return '<div class="g-fopt">' +
               '<div class="g-fk">' + (sc != null ? scorePill(sc) : esc(o.id)) + '</div>' +
               '<div class="g-ftxt"><div class="you">' + mt(o.label) + '</div>' +
                 '<div class="her">' + mt(o.reply) + '</div></div>' +
               '<div class="g-fto">' + (showTarget ? '↓ ' + stBadge(o.to) : '<span class="g-end">סוף</span>') + '</div>' +
             '</div>';
    }
    function colBox(title, node, showTarget, scoredNode) {
      return '<div class="g-fbox"><div class="g-fbox-h">' + title + '</div>' +
             '<div class="g-fprompt">' + esc(node.prompt) + '</div>' +
             node.opts.map(function (o) { return optRow(o, showTarget, scoredNode && scoredNode.opts); }).join('') + '</div>';
    }

    var legend = '<div class="g-legend">' + Object.keys(ST).map(function (id) {
      return '<div class="g-lrow">' + stBadge(id) + '<span>' + esc(ST[id].desc) + '</span></div>';
    }).join('') + '</div>';

    var flow = '<div class="g-flow">';
    flow += '<div class="g-fcol"><div class="g-fcol-h">מהלך 1 — ארבע פתיחות</div>' +
            colBox('הפתיחה', sim.t1, true, TREE.t1) + '</div>';
    flow += '<div class="g-fcol"><div class="g-fcol-h">מהלך 2 — לפי מה שקרה בפתיחה</div>' +
            Object.keys(sim.t2).map(function (k2) {
              return colBox('אם היא ' + stBadge(k2), sim.t2[k2], true, TREE.t2[k2]);
            }).join('') + '</div>';
    flow += '<div class="g-fcol"><div class="g-fcol-h">מהלך 3 — המהלך האחרון</div>' +
            Object.keys(sim.t3).map(function (k3) {
              return colBox('אם היא ' + stBadge(k3), sim.t3[k3], false, TREE.t3[k3]);
            }).join('') + '</div>';
    flow += '</div>';
    var SCR = TREE.scoring || {};
    var scoringBox = '<div class="g-side key" style="margin-bottom:14px"><div class="lbl">איך מנקדים</div>' +
      '<p>' + esc(SCR.rule || '') + '</p>' +
      '<div class="g-rubric" style="margin-top:10px">' +
        Object.keys(SCR.move_legend || {}).sort().reverse().map(function (k) {
          return '<div class="g-rrow">' + scorePill(k) + '<span>' + esc(SCR.move_legend[k]) + '</span></div>';
        }).join('') +
      '</div>' +
      '<div class="g-cap">הניתוח העצמי — נקודה לכל שורה, עד 3</div><div class="g-rubric">' +
        (SCR.reflect_rubric || []).map(function (r) {
          return '<div class="g-rrow">' + scorePill(r.pts) + '<span>' + esc(r.text) + '</span></div>';
        }).join('') +
      '</div></div>';

    out += qBlock('q5', 'מול התלמיד — השיחה (משותפת לכל המקצועות)', null,
      '<div class="t-scene">' + esc(sim.scene) + '</div>' +
      '<p class="g-note" style="margin:0 0 12px">שלושה מהלכים. כל בחירה מכניסה את התלמידה ל<b>מצב</b>, והמצב קובע אילו אפשרויות יופיעו במהלך הבא. ' +
      'סך הכול ' + (sim.t1.opts.length) + ' × 3 × 4 מסלולים אפשריים — אבל רק שבעה מצבים.</p>' +
      scoringBox +
      '<div class="g-cap">שבעת המצבים</div>' + legend +
      '<div class="g-cap">תרשים הזרימה — המספר ליד כל אפשרות הוא הניקוד שלה</div>' + flow +
      '<p class="g-ask">' + esc(sim.reflect_ask) + '</p>' +
      '<p class="g-note" style="margin:0 0 10px"><b>לא מנקדים איזה מסלול בחר — מנקדים לאן הוא הוביל.</b> ' +
      'מסלול שמסתיים ב«נתקעה במקום מוגדר» הוא הצלחה; מסלול שמסתיים ב«אבודה» או ב«פסיבית» הוא כישלון.</p>' +
      K.q5.map(function (k) {
        return '<div class="g-two" style="margin-bottom:10px">' + side('key', k.look, esc(k.good)) + side('flag', 'הדגל', esc(k.flag)) + '</div>';
      }).join(''));

    // ---------- שאלה 6 ----------
    var vmap = {}; K.q6.verdicts.forEach(function (v) { vmap[v.id] = v.verdict; });
    var o6 = q.q6.opts.map(function (o) {
      var v = vmap[o.id];
      var pill = v === 'good' ? '<span class="g-pill good">סביר</span>'
        : v === 'weak' ? '<span class="g-pill mid">חלש</span>' : '<span class="g-pill bad">נפילה</span>';
      return '<div class="g-strow"><span class="n">' + esc(o.id) + '</span><span>' + esc(o.text) + '</span>' +
             '<span class="tag">' + pill + '</span></div>';
    }).join('');
    out += qBlock('q6', 'שיקול דעת', null,
      '<p class="g-q">' + mt(q.q6.stem) + '</p>' +
      '<div class="g-steps">' + o6 + '</div>' +
      '<p class="g-ask">' + mt(q.q6.ask) + '</p>' +
      '<div class="g-side key"><div class="lbl">הנימוק חייב לכלול</div><p>' + esc(K.q6.must) + '</p></div>');

    return out;
  }

  function wireKey() {
    Array.prototype.forEach.call(document.querySelectorAll('#g-subs .g-tab'), function (b) {
      b.onclick = function () {
        S.subject = b.getAttribute('data-k');
        api('/api/examiner/teach/key/' + S.subject).then(function (k) { S.key = k; render(); });
      };
    });
  }

  // ------------------------------------------------------------- ציור
  function render() {
    if (!S.token) return drawLogin();
    var inner = S.open ? cardHtml() : (S.tab === 'people' ? peopleHtml() : keyHtml());
    root.innerHTML = shell(inner);
    wireShell();
    if (S.open) {
      var b = document.getElementById('g-back');
      if (b) b.onclick = function () { S.open = null; S.card = null; render(); };
      mountGrading();
    } else if (S.tab === 'people') wirePeople();
    else wireKey();
  }

  function refresh() {
    return api('/api/examiner/teach/list').then(function (l) {
      // רשימת המקצועות לצורך לשונית המפתח
      return fetch('/api/teach/subjects').then(function (r) { return r.json(); }).then(function (s) {
        l.subjects = s.subjects; S.list = l;
        if (S.open) return openCard(S.open);
        render();
      });
    }).catch(function (e) {
      if (/נדחתה|401/.test(e.message)) { S.token = null; try { sessionStorage.removeItem(KEY); } catch (x) { } drawLogin(); }
    });
  }

  function boot() {
    api('/api/examiner/teach/key/' + S.subject).then(function (k) { S.key = k; return refresh(); }).then(function () {
      if (poll) clearInterval(poll);
      poll = setInterval(function () { if (!S.open) refresh(); }, 10000);   // רשימה חיה
    }).catch(function () { S.token = null; drawLogin(); });
  }

  try { S.token = sessionStorage.getItem(KEY); } catch (e) { }
  if (S.token) boot(); else drawLogin();
})();
