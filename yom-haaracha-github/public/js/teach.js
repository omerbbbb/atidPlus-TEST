/* ==========================================================================
 *  בוחן ההוראה — מסך המועמד
 *
 *  ⚠ השעון הוא של השרת. כאן רק סופרים אחורה בין קריאה לקריאה, ומסנכרנים
 *    כל 15 שניות. אם המועמד סוגר, מרענן או משנה את שעון המחשב — לא עוזר.
 *  ⚠ אין חזרה לעריכה. «הקודם» מציג שאלה קודמת נעולה בלבד.
 * ========================================================================== */
(function () {
  var root = document.getElementById('root');
  var TOKEN_KEY = 'teach_token';

  var S = {
    token: null,
    state: null,          // מה שהשרת אמר לאחרונה
    i: -1,                // המסך המוצג
    reached: -1,          // הרחוק ביותר שהמועמד באמת הגיע אליו
    answers: {},          // qid -> value
    spent: {},            // qid -> שניות
    remaining: 0,
    tickAt: 0,
    subject: null,
    error: ''
  };

  var timer = null, poller = null, saveTimer = null, qEnteredAt = 0;

  // ---------------------------------------------------------------- עזרים
  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function mt(s) { return window.renderMathText ? window.renderMathText(s) : esc(s); }
  function fmt(t) {
    t = Math.max(0, Math.round(t));
    var m = Math.floor(t / 60), s = t % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function heb(i) { return ['א', 'ב', 'ג', 'ד', 'ה', 'ו'][i] || String(i + 1); }

  function api(path, data) {
    return fetch(path, {
      method: data ? 'POST' : 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, S.token ? { 'x-token': S.token } : {}),
      body: data ? JSON.stringify(data) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || 'שגיאת שרת. נסה שוב.');
        return j;
      });
    });
  }

  // ---------------------------------------------------------------- שעון
  function startClock() {
    stopClock();
    S.tickAt = Date.now();
    timer = setInterval(function () {
      if (S.state && (S.state.paused || S.state.review)) { paintClock(); return; }
      var dt = (Date.now() - S.tickAt) / 1000;
      S.tickAt = Date.now();
      S.remaining = Math.max(0, S.remaining - dt);
      paintClock();
      if (S.remaining <= 0) sync();          // השרת יכריע ויסגור
    }, 1000);
    poller = setInterval(sync, 15000);       // סנכרון מול מקור האמת
  }
  function stopClock() {
    if (timer) clearInterval(timer); timer = null;
    if (poller) clearInterval(poller); poller = null;
  }
  function paintClock() {
    var c = document.getElementById('t-clock');
    if (!c) return;
    if (S.state && S.state.review) { c.textContent = 'בדיקה'; c.className = 't-clock hold'; return; }
    c.textContent = S.state && S.state.paused ? 'עוצר' : fmt(S.remaining);
    c.className = 't-clock' + (S.state && S.state.paused ? ' hold'
      : S.remaining <= 60 ? ' crit' : S.remaining <= 300 ? ' warn' : '');
  }

  function sync() {
    return api('/api/teach/state').then(function (st) {
      var wasRunning = S.state && S.state.status === 'running';
      var prevReopen = JSON.stringify((S.state && S.state.reopened) || []);
      S.state = st;
      S.remaining = st.remaining_sec;
      S.tickAt = Date.now();
      if (st.status !== 'running' && wasRunning) { stopClock(); draw(); }
      else if (st.status === 'running' && !wasRunning) { applyState(st); qEnteredAt = Date.now(); draw(); }   // נפתח מחדש אחרי הגשה
      else if (JSON.stringify(st.reopened || []) !== prevReopen) draw();
      else paintClock();
    }).catch(function () { /* רשת נפלה — הספירה המקומית ממשיכה */ });
  }

  // ---------------------------------------------------------------- שמירה
  function markSaving(on) {
    var s = document.getElementById('t-saving');
    if (s) s.textContent = on ? 'שומר…' : '';
  }
  function saveNow(qid, reached) {
    if (!qid || !S.state || S.state.status !== 'running') return Promise.resolve();
    var spent = (S.spent[qid] || 0) + Math.round((Date.now() - qEnteredAt) / 1000);
    markSaving(true);
    var body = { qid: qid, value: S.answers[qid] || null, time_spent_sec: spent };
    if (reached !== undefined) body.reached = reached;        // «הבא» נלחץ — השרת זוכר עד איפה הגענו
    return api('/api/teach/answer', body)
      .then(function (r) { S.remaining = r.remaining_sec; S.tickAt = Date.now(); })
      .catch(function () { })
      .then(function () { markSaving(false); });
  }
  function saveSoon(qid) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveNow(qid); }, 900);
  }

  // ---------------------------------------------------------------- שלד
  function shell(inner, qcount) {
    var segs = '';
    for (var k = 0; k < (qcount || 0); k++) {
      segs += '<div class="t-seg' + (k === S.i ? ' now' : k < S.reached ? ' done' : '') + '"></div>';
    }
    var reopened = (S.state && S.state.reopened) || [];
    var banner = '';
    if (reopened.length) {
      var qs = questions(); var cur = qs[S.i] && qs[S.i].id;
      var others = reopened.filter(function (id) {
        var k = qs.findIndex(function (x) { return x.id === id; });
        return id !== cur && k >= 0 && k < S.reached;      // רק שאלות שכבר ננעלו
      });
      if (others.length) {
        banner = '<div class="t-banner">המנהל פתח לך מחדש לעריכה: ' +
          others.map(function (id) { var k = qs.findIndex(function (x) { return x.id === id; });
            return '<button class="t-ghost small" data-jump="' + k + '">שאלה ' + (k + 1) + '</button>'; }).join(' ') + '</div>';
      }
    }
    return '<div class="t-bar">' +
             '<div class="t-brand">עתיד פלוס <span>· בוחן הוראה</span></div>' +
             '<div class="t-segs">' + segs + '</div>' +
             '<div class="t-clock" id="t-clock">' + fmt(S.remaining) + '</div>' +
           '</div>' + banner +
           '<div class="t-screen">' + inner + '</div>';
  }

  function foot(hint, primary, opts) {
    opts = opts || {};
    return '<div class="t-foot">' +
             '<div class="t-hint">' + esc(hint || '') + ' <span class="t-saving" id="t-saving"></span></div>' +
             '<div class="t-btns">' +
               (opts.back ? '<button class="t-ghost" id="t-back">הקודם</button>' : '') +
               '<button class="t-go" id="t-next"' + (opts.disabled ? ' disabled' : '') + '>' + esc(primary) + '</button>' +
             '</div>' +
           '</div>';
  }

  // ---------------------------------------------------------------- כניסה
  function drawLogin() {
    root.innerHTML =
      '<div class="t-bar"><div class="t-brand">עתיד פלוס <span>· בוחן הוראה</span></div></div>' +
      '<div class="t-screen"><div class="t-center">' +
        '<h2>בוחן הוראה למועמדים</h2>' +
        '<p>הזן את פרטיך כדי להיכנס. אם כבר התחלת — אותם פרטים יחזירו אותך למקום שבו עצרת.</p>' +
        '<div class="t-form">' +
          '<div><label for="f-name">שם מלא</label><input id="f-name" autocomplete="name" /></div>' +
          '<div><label for="f-pin">סיסמה שתבחר (4 תווים לפחות)</label><input id="f-pin" autocomplete="off" /></div>' +
          '<div><label for="f-phone">טלפון</label><input id="f-phone" inputmode="tel" autocomplete="tel" /></div>' +
        '</div>' +
        '<p class="t-err" id="t-err">' + esc(S.error) + '</p>' +
      '</div>' +
      '<div class="t-foot"><div class="t-hint">הסיסמה היא שלך — היא רק מאפשרת לך לחזור אם משהו נסגר.</div>' +
      '<div class="t-btns"><button class="t-go" id="t-login">כניסה</button></div></div></div>';

    var go = document.getElementById('t-login');
    function submit() {
      var name = document.getElementById('f-name').value.trim();
      var pin = document.getElementById('f-pin').value.trim();
      var phone = document.getElementById('f-phone').value.trim();
      go.disabled = true;
      api('/api/teach/login', { name: name, pin: pin, phone: phone }).then(function (r) {
        S.token = r.token; S.error = '';
        try { localStorage.setItem(TOKEN_KEY, r.token); } catch (e) { }
        applyState(r.state); draw();
      }).catch(function (e) {
        S.error = e.message; go.disabled = false;
        document.getElementById('t-err').textContent = e.message;
      });
    }
    go.onclick = submit;
    ['f-name', 'f-pin', 'f-phone'].forEach(function (id) {
      document.getElementById(id).onkeydown = function (ev) { if (ev.key === 'Enter') submit(); };
    });
  }

  // ---------------------------------------------------------------- הוראות
  function drawInstructions() {
    var ins = S.state.instructions || {};
    function li(arr) { return (arr || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join(''); }
    root.innerHTML =
      '<div class="t-bar"><div class="t-brand">עתיד פלוס <span>· בוחן הוראה</span></div>' +
      '<div class="t-clock">' + fmt(S.state.duration_sec) + '</div></div>' +
      '<div class="t-screen">' +
        '<h2 class="t-ins-h">' + esc(ins.title || 'הוראות המבחן') + '</h2>' +
        '<p class="t-brief">' + esc(ins.intro || '') + '</p>' +
        '<div class="t-ins-grid">' +
          '<div class="t-ins ok"><div class="t-cap">מותר</div><ul>' + li(ins.allowed) + '</ul></div>' +
          '<div class="t-ins no"><div class="t-cap">אסור</div><ul>' + li(ins.forbidden) + '</ul></div>' +
        '</div>' +
        '<div class="t-cap" style="margin-top:14px">איך המבחן עובד</div><ul class="t-ins-rules">' + li(ins.rules) + '</ul>' +
        '<label class="t-ack"><input type="checkbox" id="t-ack"> <span>' + esc(ins.ack || 'קראתי ואני מאשר.') + '</span></label>' +
        '<div class="t-foot"><div class="t-hint">אחרי האישור תבחר מקצוע. השעון מתחיל רק בלחיצה על «התחל».</div>' +
        '<div class="t-btns"><button class="t-go" id="t-next" disabled>המשך לבחירת מקצוע</button></div></div>' +
      '</div>';
    var cb = document.getElementById('t-ack'), nx = document.getElementById('t-next');
    if (cb && nx) { cb.onchange = function () { nx.disabled = !cb.checked; }; nx.onclick = function () { S.ack = true; drawChoose(); }; }
  }

  // ---------------------------------------------------------------- בחירת מקצוע
  function drawChoose() {
    if (!S.ack) return drawInstructions();
    var subs = (S.state.subjects || []);
    var chips = subs.map(function (s) {
      return '<button class="t-subj' + (S.subject === s.id ? ' sel' : '') + '" data-s="' + esc(s.id) + '">' + esc(s.name) + '</button>';
    }).join('');
    root.innerHTML =
      '<div class="t-bar"><div class="t-brand">עתיד פלוס <span>· בוחן הוראה</span></div>' +
      '<div class="t-clock">' + fmt(S.state.duration_sec) + '</div></div>' +
      '<div class="t-screen"><div class="t-center">' +
        '<h2>שלום ' + esc(S.state.name) + '</h2>' +
        '<p>בחר את המקצוע שאתה מועמד ללמד. שאלת הבגרות תהיה ממנו; שאר השאלות זהות בכל המקצועות.</p>' +
        '<div class="t-subjects" id="t-subs">' + chips + '</div>' +
        '<p class="t-note" id="t-note"></p>' +
        '<ul class="t-rules">' +
          '<li>שש שאלות, ' + Math.round(S.state.duration_sec / 60) + ' דקות. השעון לא נעצר</li>' +
          '<li>שאלה אחת בכל מסך. אפשר לחזור ולקרוא שאלה קודמת — לא לשנות אותה</li>' +
          '<li>אין אורך חובה לתשובה. יש אורך מומלץ</li>' +
          '<li>בשאלות הפתוחות אין תשובה אחת נכונה</li>' +
        '</ul>' +
        '<p class="t-err" id="t-err"></p>' +
      '</div>' +
      '<div class="t-foot"><div class="t-hint">אין צורך בהכנה. אנחנו רוצים לראות איך אתה חושב מול תלמיד.</div>' +
      '<div class="t-btns"><button class="t-go" id="t-next"' + (S.subject ? '' : ' disabled') + '>התחל</button></div></div></div>';

    var note = document.getElementById('t-note');
    var next = document.getElementById('t-next');
    Array.prototype.forEach.call(document.querySelectorAll('.t-subj'), function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call(document.querySelectorAll('.t-subj'), function (x) { x.classList.remove('sel'); });
        b.classList.add('sel');
        S.subject = b.getAttribute('data-s');
        var s = subs.filter(function (x) { return x.id === S.subject; })[0];
        note.innerHTML = s ? (esc(s.exam + ' · ' + s.topic) + (s.aids ? '<span class="t-aids"><b>חומר עזר מותר:</b> ' + esc(s.aids) + '</span>' : '')) : '';
        next.disabled = false;
      };
    });
    next.onclick = function () {
      next.disabled = true;
      api('/api/teach/start', { subject_id: S.subject }).then(function (st) {
        applyState(st); S.i = 0; S.reached = 0; qEnteredAt = Date.now();
        startClock(); draw();
      }).catch(function (e) {
        next.disabled = false;
        document.getElementById('t-err').textContent = e.message;
      });
    };
  }

  // ---------------------------------------------------------------- שאלות
  function questions() { return (S.state.exam && S.state.exam.questions) || []; }

  function head(q, ro) {
    return '<div class="t-meta">' +
             '<span class="part">' + esc(q.part) + '</span><span>·</span>' +
             '<span>' + esc(q.label) + ' מתוך ' + questions().length + '</span>' +
             (ro ? '<span>·</span><span class="ro">צפייה בלבד</span>' : '') +
           '</div>' +
           (q.stem ? '<p class="t-stem">' + mt(q.stem) + '</p>' : '');
  }

  function textArea(q, val, ro) {
    return '<p class="t-ask">' + mt(q.ask) + '</p>' +
           '<textarea id="t-ta" maxlength="' + q.cap + '" placeholder="כתוב כאן"' + (ro ? ' disabled' : '') + '>' + esc(val || '') + '</textarea>' +
           '<div class="t-count" id="t-count"></div>';
  }

  function wireText(q, ro, onChange) {
    var ta = document.getElementById('t-ta'), c = document.getElementById('t-count');
    if (!ta) return;
    function upd() {
      if (ta.value.length > q.cap) ta.value = ta.value.slice(0, q.cap);
      c.textContent = ta.value.length + ' / ' + q.cap + '   ·   מומלץ סביב ' + q.rec;
      c.className = 't-count' + (ta.value.length >= q.cap ? ' full' : '');
      if (onChange) onChange(ta.value);
    }
    if (!ro) ta.oninput = upd;
    upd();
  }

  function stepsHtml(q, sel, ro) {
    var rows = q.steps.map(function (s, k) {
      return '<button class="t-step' + (sel === k + 1 ? ' sel' : '') + '" data-k="' + (k + 1) + '"' + (ro ? ' disabled' : '') + '>' +
               '<span class="no">' + (k + 1) + '</span>' +
               '<span class="body' + (q.steps_ltr ? ' ltr' : '') + '">' + mt(s) + '</span>' +
             '</button>';
    }).join('');
    return '<div class="t-steps">' + rows + '</div>';
  }

  function draw() {
    if (!S.state) return drawLogin();
    if (S.state.status === 'registered') return drawChoose();
    if (S.state.status === 'submitted') return drawDone();

    var qs = questions();
    var q = qs[S.i];
    if (!q) { S.i = 0; q = qs[0]; }
    var reopened = (S.state.reopened || []);
    var ro = S.i < S.reached && reopened.indexOf(q.id) < 0;
    var a = S.answers[q.id] || {};
    var last = (S.i === qs.length - 1);
    var body = '';

    if (q.type === 'steps') {
      var brief = (q.brief_kind === 'math')
        ? '<div class="t-source t-math">' + mt(q.brief_body) + '</div>'
        : '<div class="t-cap">' + esc(q.brief_label) + '</div>' +
          '<div class="t-source' + (q.brief_ltr ? ' ltr' : '') + '">' + mt(q.brief_body) + '</div>';
      var wide = q.ans_type === 'text';
      body = head(q, ro) +
        '<div class="t-brief">' + mt(q.brief_he) + '</div>' + brief +
        '<div class="t-cap">' + esc(q.steps_label) + '</div>' + stepsHtml(q, a.step, ro) +
        '<p class="t-ask">' + mt(q.ask) + '</p>' +
        '<div class="t-ansrow">' +
          '<span class="lbl">' + esc(q.ans_label) + '</span>' +
          '<input id="t-ans" class="' + (wide ? 'wide' : 'num') + '" autocomplete="off" value="' + esc(a.text || '') + '"' + (ro ? ' disabled' : '') + ' />' +
          '<span class="lbl">' + esc(q.ans_note) + '</span>' +
        '</div>' +
        foot(q.hint, ro ? ('חזרה לשאלה ' + (S.reached + 1)) : (last ? 'הגש' : 'הבא'), { back: S.i > 0 });

    } else if (q.type === 'plans') {
      var cards = q.plans.map(function (p) {
        var beats = p.beats.map(function (b) { return '<span class="cbeat"><b>' + esc(b[0]) + '</b>' + esc(b[1]) + '</span>'; }).join('');
        return '<button class="t-card' + (a.plan === p.id ? ' sel' : '') + '" data-p="' + esc(p.id) + '"' + (ro ? ' disabled' : '') + '>' +
                 '<span class="cname">' + esc(p.name) + '</span>' + beats + '</button>';
      }).join('');
      body = head(q, ro) + '<div class="t-cards">' + cards + '</div>' + textArea(q, a.text, ro) +
             foot(q.hint, ro ? ('חזרה לשאלה ' + (S.reached + 1)) : (last ? 'הגש' : 'הבא'), { back: S.i > 0 });

    } else if (q.type === 'mcjust') {
      var opts = q.opts.map(function (o, k) {
        return '<button class="t-opt' + (a.pick === o.id ? ' sel' : '') + '" data-o="' + esc(o.id) + '"' + (ro ? ' disabled' : '') + '>' +
                 '<span class="key">' + heb(k) + '</span><span>' + esc(o.text) + '</span></button>';
      }).join('');
      body = head(q, ro) + '<div class="t-opts">' + opts + '</div>' + textArea(q, a.text, ro) +
             foot(q.hint, ro ? ('חזרה לשאלה ' + (S.reached + 1)) : (last ? 'הגש' : 'הבא'), { back: S.i > 0 });

    } else if (q.type === 'sim') {
      return drawSim(q, a, ro, last);

    } else {                                   // text
      var pre = '';
      if (q.recall) {
        var rows = q.steps.map(function (s, k) {
          return '<div class="t-rline"><span class="n">' + (k + 1) + '</span>' +
                 '<span' + (q.steps_ltr ? ' class="ltr"' : '') + '>' + mt(s) + '</span></div>';
        }).join('');
        pre += '<details class="t-recall"><summary>הצג שוב את התשובה של התלמיד</summary><div class="inner">' + rows + '</div></details>';
      }
      if (q.profile) {
        // «נועה · כיתה יא׳…» — השם מודגש, השאר רגיל. בלי HTML בתוך התוכן.
        var pp = String(q.profile).split(' · ');
        pre += '<div class="t-profile"><b>' + esc(pp[0]) + '</b>' +
               (pp.length > 1 ? ' · ' + esc(pp.slice(1).join(' · ')) : '') + '</div>';
      }
      if (q.ai) pre += '<div class="t-cap">ההסבר שנכתב ע״י AI</div><div class="t-ai' + (q.ai_ltr ? ' ltr' : '') + '">' + esc(q.ai) + '</div>';
      body = head(q, ro) + pre + textArea(q, a.text, ro) + foot(q.hint, ro ? ('חזרה לשאלה ' + (S.reached + 1)) : (last ? 'הגש' : 'הבא'), { back: S.i > 0 });
    }

    root.innerHTML = shell(body, qs.length);
    paintClock();

    // חיווט
    if (q.type === 'steps') {
      var input = document.getElementById('t-ans');
      if (!ro) {
        Array.prototype.forEach.call(document.querySelectorAll('.t-step'), function (b) {
          b.onclick = function () {
            Array.prototype.forEach.call(document.querySelectorAll('.t-step'), function (x) { x.classList.remove('sel'); });
            b.classList.add('sel');
            a.step = Number(b.getAttribute('data-k'));
            S.answers[q.id] = a; saveSoon(q.id);
          };
        });
        input.oninput = function () { a.text = input.value; S.answers[q.id] = a; saveSoon(q.id); };
      }
    } else if (q.type === 'plans') {
      wireText(q, ro, function (v) { a.text = v; S.answers[q.id] = a; saveSoon(q.id); });
      if (!ro) Array.prototype.forEach.call(document.querySelectorAll('.t-card'), function (b) {
        b.onclick = function () {
          Array.prototype.forEach.call(document.querySelectorAll('.t-card'), function (x) { x.classList.remove('sel'); });
          b.classList.add('sel'); a.plan = b.getAttribute('data-p');
          S.answers[q.id] = a; saveSoon(q.id);
        };
      });
    } else if (q.type === 'mcjust') {
      wireText(q, ro, function (v) { a.text = v; S.answers[q.id] = a; saveSoon(q.id); });
      if (!ro) Array.prototype.forEach.call(document.querySelectorAll('.t-opt'), function (b) {
        b.onclick = function () {
          Array.prototype.forEach.call(document.querySelectorAll('.t-opt'), function (x) { x.classList.remove('sel'); });
          b.classList.add('sel'); a.pick = b.getAttribute('data-o');
          S.answers[q.id] = a; saveSoon(q.id);
        };
      });
    } else {
      wireText(q, ro, function (v) { a.text = v; S.answers[q.id] = a; saveSoon(q.id); });
      var ta = document.getElementById('t-ta'); if (ta && !ro) ta.focus();
    }
    wireNav(q, ro, last);
  }

  // ---------------------------------------------------------------- השיחה
  function drawSim(q, a, ro, last) {
    if (!a.path) a.path = [];
    var stage = a.path.length;

    var convo = a.path.map(function (t, k) {
      return '<div class="t-turn you"><span class="who">אתה</span>' +
               (ro ? '' : '<button class="t-redo" data-r="' + k + '">שנה מכאן</button>') +
               mt(t.label) + '</div>' +
             '<div class="t-turn her"><span class="who">התלמידה</span>' + mt(t.reply) + '</div>';
    }).join('');

    var node = stage === 0 ? q.t1
      : stage === 1 ? q.t2[a.path[0].to]
      : stage === 2 ? (q.t3[a.path[1].to] || q.t3.stuck) : null;

    var body = head(q, ro) + '<div class="t-scene">' + esc(q.scene) + '</div>' +
               (convo ? '<div class="t-convo">' + convo + '</div>' : '');

    if (stage < 3 && !ro) {
      body += '<p class="t-ask">' + esc(node.prompt) + '</p><div class="t-opts">' +
        node.opts.map(function (o, k) {
          return '<button class="t-opt" data-i="' + k + '"><span class="key">' + heb(k) + '</span><span>' + mt(o.label) + '</span></button>';
        }).join('') + '</div>' +
        foot('בחר מהלך. התלמידה תגיב, ואז תבחר שוב. אפשר לחזור ולשנות כל מהלך.', last ? 'הגש' : 'הבא', { back: S.i > 0, disabled: true });
    } else {
      body += '<p class="t-ask">' + esc(q.reflect_ask) + '</p>' +
        '<textarea id="t-ta" maxlength="' + q.cap + '" placeholder="כתוב כאן"' + (ro ? ' disabled' : '') + '>' + esc(a.text || '') + '</textarea>' +
        '<div class="t-count" id="t-count"></div>' +
        foot(q.reflect_hint, ro ? ('חזרה לשאלה ' + (S.reached + 1)) : (last ? 'הגש' : 'הבא'), { back: S.i > 0 });
    }

    root.innerHTML = shell(body, questions().length);
    paintClock();

    if (stage < 3 && !ro) {
      Array.prototype.forEach.call(document.querySelectorAll('.t-opt'), function (b) {
        b.onclick = function () {
          var o = node.opts[Number(b.getAttribute('data-i'))];
          a.path.push({ id: o.id, label: o.label, reply: o.reply, to: o.to || 'stuck' });
          S.answers[q.id] = a; saveSoon(q.id);
          drawSim(q, a, ro, last);
        };
      });
    } else {
      wireText(q, ro, function (v) { a.text = v; S.answers[q.id] = a; saveSoon(q.id); });
    }
    if (!ro) Array.prototype.forEach.call(document.querySelectorAll('.t-redo'), function (b) {
      b.onclick = function () {
        var ta = document.getElementById('t-ta'); if (ta) a.text = ta.value;
        a.path = a.path.slice(0, Number(b.getAttribute('data-r')));
        S.answers[q.id] = a; saveSoon(q.id);
        drawSim(q, a, ro, last);
      };
    });
    wireNav(q, ro, last);
  }

  // ---------------------------------------------------------------- ניווט
  function wireNav(q, ro, last) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-jump]'), function (b) {
      b.onclick = function () { S.i = Number(b.getAttribute('data-jump')); qEnteredAt = Date.now(); draw(); };
    });
    var back = document.getElementById('t-back');
    var next = document.getElementById('t-next');
    if (back) back.onclick = function () {
      if (!ro) { S.spent[q.id] = (S.spent[q.id] || 0) + Math.round((Date.now() - qEnteredAt) / 1000); saveNow(q.id); }
      S.i = S.i - 1; qEnteredAt = Date.now(); draw();
    };
    if (!next) return;
    next.onclick = function () {
      if (ro) { S.i = S.reached; qEnteredAt = Date.now(); return draw(); }
      S.spent[q.id] = (S.spent[q.id] || 0) + Math.round((Date.now() - qEnteredAt) / 1000);
      qEnteredAt = Date.now();
      next.disabled = true;
      saveNow(q.id, last ? undefined : Math.max(S.reached, S.i + 1)).then(function () {
        if (last) return api('/api/teach/submit', {}).then(function (st) { stopClock(); applyState(st); draw(); });
        S.i += 1; S.reached = Math.max(S.reached, S.i);
        draw();
      }).catch(function () { next.disabled = false; });
    };
  }

  // ---------------------------------------------------------------- סיום
  function drawDone() {
    stopClock();
    if (!poller) poller = setInterval(sync, 15000);   // אם המנהל יפתח מחדש — נחזור למבחן
    root.innerHTML =
      '<div class="t-bar"><div class="t-brand">עתיד פלוס <span>· בוחן הוראה</span></div></div>' +
      '<div class="t-screen"><div class="t-center">' +
        '<h2>המבחן הוגש</h2>' +
        '<p>תודה ' + esc(S.state.name) + '. התשובות נשמרו, ונחזור אליך בימים הקרובים.</p>' +
        '<p>אפשר לסגור את החלון.</p>' +
      '</div></div>';
  }

  // ---------------------------------------------------------------- אתחול
  function applyState(st) {
    S.state = st;
    S.remaining = st.remaining_sec;
    S.tickAt = Date.now();
    if (st.answers) {
      S.answers = {}; S.spent = {};
      Object.keys(st.answers).forEach(function (qid) {
        S.answers[qid] = st.answers[qid].value || {};
        S.spent[qid] = st.answers[qid].time_spent_sec || 0;
      });
      // מרענן באמצע מבחן — ממשיכים מהשאלה הרחוקה ביותר שהגענו אליה (השרת זוכר),
      // כך ששאלה שכבר עברנו ממנה נשארת נעולה גם אחרי רענון.
      var qs = (st.exam && st.exam.questions) || [];
      var lastAnswered = -1;
      qs.forEach(function (q, k) { if (st.answers[q.id]) lastAnswered = k; });
      if (S.i < 0) { S.reached = Math.min(qs.length - 1, Math.max(0, st.reached || 0, lastAnswered)); S.i = S.reached; }
    }
    if (st.status === 'running' && !timer) startClock();
  }

  window.addEventListener('beforeunload', function () {
    var q = questions()[S.i];
    if (q && S.state && S.state.status === 'running' && navigator.sendBeacon) {
      var spent = (S.spent[q.id] || 0) + Math.round((Date.now() - qEnteredAt) / 1000);
      navigator.sendBeacon('/api/teach/answer', new Blob(
        [JSON.stringify({ qid: q.id, value: S.answers[q.id] || null, time_spent_sec: spent, _t: S.token })],
        { type: 'application/json' }));
    }
  });

  // פתיחה ישירה מהמסך של המנהל: /teach#t=<אסימון>. מצב בדיקה בלבד.
  (function () {
    var m = /[#&]t=([a-f0-9]+)/i.exec(location.hash || '');
    if (m) {
      S.token = m[1];
      try { localStorage.setItem(TOKEN_KEY, m[1]); } catch (e) { }
      history.replaceState(null, '', location.pathname);
      return;
    }
    try { S.token = localStorage.getItem(TOKEN_KEY); } catch (e) { }
  })();
  if (S.token) {
    api('/api/teach/state').then(function (st) { applyState(st); qEnteredAt = Date.now(); draw(); })
      .catch(function () { S.token = null; try { localStorage.removeItem(TOKEN_KEY); } catch (e) { } drawLogin(); });
  } else {
    drawLogin();
  }
})();
