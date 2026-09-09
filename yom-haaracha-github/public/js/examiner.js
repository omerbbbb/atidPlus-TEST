/* =========================================================================
   מסך המנהל — קונסולת ניהול חיה (מודל סבב-אחר-סבב).
   נכנסים מהכפתור "כניסת מנהל" או מהכתובת /examiner. חושף window.AdminApp={enter,leave}.
   ========================================================================= */
window.AdminApp = (function () {
  'use strict';

  var token = localStorage.getItem('yh_examiner_token') || null;
  var pollHandle = null;
  // ⚠ מזהה נפרד לשעון-השנייה. בלי לשמור ולנקות אותו, כל כניסה חוזרת מוסיפה
  // interval נוסף והספירה יורדת כמה שניות בשנייה (הבאג שהיה במסך המראיין).
  var tickHandle = null;
  var root = document.getElementById('root');
  var availableSubjects = [];
  var addSubjects = [];
  var STATE = null;

  function el(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtTime(sec) { if (sec == null) return '--:--'; var m = String(Math.floor(sec / 60)).padStart(2, '0'), s = String(sec % 60).padStart(2, '0'); return m + ':' + s; }

  async function call(path, method, body, raw) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['x-token'] = token;
    var res = await fetch('/api' + path, { method: method || 'GET', headers: headers, body: body ? JSON.stringify(body) : undefined });
    if (raw) return res;
    var data = null; try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw Object.assign(new Error((data && data.error) || 'שגיאה'), { status: res.status });
    return data;
  }

  // ------------------------------------------------- כניסה
  function renderLogin(errMsg) {
    if (pollHandle) clearInterval(pollHandle);
    root.className = 'center-screen';
    root.innerHTML = '';
    root.appendChild(el(
      '<div class="card" style="max-width:400px;width:100%">' +
      '<div class="brand"><img class="logo" src="/img/logo.svg" alt="עתיד פלוס"><span class="wordmark">עתיד פלוס</span><span class="sub">מסך מנהל</span></div>' +
      '<h2>כניסת מנהל</h2><p class="lead">הזינו את סיסמת הבוחן.</p>' +
      (errMsg ? '<div class="msg error">' + esc(errMsg) + '</div>' : '') +
      '<label class="field"><span>סיסמה</span><input id="pw" type="password" autocomplete="off"></label>' +
      '<div class="btn-row"><button class="btn" id="go">כניסה</button>' +
      '<button class="btn ghost" id="back-exam">חזרה למסך הנבחן</button></div></div>'
    ));
    document.getElementById('go').onclick = doLogin;
    document.getElementById('back-exam').onclick = leave;
    document.getElementById('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  }
  async function doLogin() {
    try {
      var r = await call('/examiner/login', 'POST', { password: document.getElementById('pw').value });
      token = r.token; localStorage.setItem('yh_examiner_token', token);
      start();
    } catch (e) { renderLogin('סיסמה שגויה.'); }
  }

  // ------------------------------------------------- מבנה המסך
  function renderShell() {
    root.className = 'wrap';
    root.innerHTML = '';
    root.appendChild(el(
      '<div>' +
      '<div class="exm-header">' +
      '<img class="logo" src="/img/logo.svg" alt="עתיד פלוס" style="height:42px">' +
      '<span class="wordmark" style="font-size:20px;font-weight:800">עתיד פלוס</span>' +
      '<span style="color:var(--muted);font-size:14px">· מסך מנהל</span>' +
      '<div class="spacer"></div>' +
      '<button class="btn ghost small" id="btn-health">תקינות בנק התוכן</button>' +
      '<button class="btn small" id="btn-roster" title="שמות, קודים אישיים וסבב ריאיון — לגיבוי אצלך">רשימת נבחנים וקודים</button>' +
      '<button class="btn small" id="btn-excel" title="כל התשובות כאקסל">הורד תשובות (Excel)</button>' +
      '<button class="btn ghost small" id="btn-export" title="גיבוי JSON לבדיקת AI">JSON</button>' +
      '<button class="btn small" id="btn-grade" title="בדיקה, ציונים ודירוג (אחרי יום המבחן)">מסך בדיקה</button>' +
      // בוחן ההוראה למועמדים — עולם נפרד (טבלאות, כניסה וגיליון משלו). קישור בלבד, לא כפתור מחווט.
      '<a class="btn ghost small" href="/teach-grade" style="text-decoration:none" title="פיקוח ובדיקה של מועמדים להוראה — נפרד מיום ההערכה">מועמדים להוראה</a>' +
      '<button class="btn ghost small" id="btn-logout">יציאה</button></div>' +
      '<div id="render-err"></div>' +
      '<div id="ended-banner"></div>' +
      // הקמת יום הערכה: בחירת יום, כותרת, מספר סבבים, שלב היום
      '<div class="card"><div id="day-setup"></div></div>' +
      // בקשות החלפה מהמראיינים
      '<div id="swaps"></div>' +
      // מה נשמר מהיום הזה (צילום לבדיקה)
      '<div id="day-saves"></div>' +
      // פס מוכנות — תנאי בסיס ושיבוץ ריאיונות
      '<div id="readiness"></div>' +
      // מראיינים וחדרים
      '<div class="card"><div id="interviewers"></div></div>' +
      // העלאת בריפים על המרואיינים
      '<div class="card"><div id="briefs"></div></div>' +
      // קונסולת הסבב
      '<div class="card"><div id="console"></div></div>' +
      // לוח תכנון — מי בריאיון בכל אחד מ-5 הסבבים
      '<div class="card"><div class="toolbar"><h2 class="section-title">לוח תכנון — מי בריאיון בכל סבב</h2>' +
      '<span class="spacer"></span><button class="btn ghost small" id="btn-autosplit">חלק לקבוצות</button></div>' +
      '<p class="hint-text">בטבלת הנבחנים למטה קובעים לכל אחד באיזה סבב הריאיון שלו (הכפתורים 1–5). כאן רואים את התמונה המלאה. אפשר לשנות לפני שסבב מתחיל; סבב שרץ/הסתיים נעול. הפרקים מסתדרים אוטומטית מסביב.</p>' +
      '<div class="plan-cols" id="planboard"></div></div>' +
      // מטריצה מלאה — נבחן × 5 סבבים
      '<div class="card"><div class="toolbar"><h2 class="section-title">מטריצה מלאה — נבחן × סבב</h2>' +
      '<span class="spacer"></span><button class="btn ghost small" id="btn-matrix-toggle">הסתר</button></div>' +
      '<div class="matrix-legend">' +
      '<span><span class="sw" style="background:rgba(69,184,78,0.5)"></span>נעשה</span>' +
      '<span><span class="sw" style="background:var(--teal)"></span>עכשיו</span>' +
      '<span><span class="sw" style="background:#3a4788"></span>ריאיון</span>' +
      '<span><span class="sw" style="border:1px dashed #6b76b0"></span>צפי (טרם נקבע)</span>' +
      '</div>' +
      '<p class="hint-text">עבר והווה מוצגים כפי שקרו בפועל; סבבים עתידיים הם <b>צפי</b> בלבד (נקבעים סופית כשהסבב מתחיל). לחיצה על תא פותחת את כרטיס הנבחן.</p>' +
      '<div style="overflow-x:auto" id="matrix"></div></div>' +
      // רשימת הנבחנים + סטטוס
      '<div class="card" style="margin-top:20px"><div class="toolbar"><h2 class="section-title">נבחנים וסטטוס</h2>' +
      '<span class="spacer"></span><span id="summary" class="health-list"></span></div>' +
      '<p class="hint-text" id="roster-hint"></p>' +
      '<div style="overflow-x:auto"><table class="grid" id="tbl"><thead><tr>' +
      '<th>שם</th><th>לריאיון?</th><th>מראיין/חדר</th><th>סטטוס</th><th>עכשיו</th><th>זמן</th><th>התראות</th><th>פעולות</th>' +
      '</tr></thead><tbody id="tbody"></tbody></table></div></div>' +
      // ניהול נבחנים
      '<div class="card"><h2 class="section-title">ניהול נבחנים</h2>' +
      '<p class="hint-text">פתח/י משתמשים מראש (ביום עצמו הנבחן נכנס עם השם והקוד). אם לא תבחר/י מקצועות — הנבחן בוחר בעצמו בכניסה. זה גם המקום להוסיף נבחנים לבדיקה (וכפתור ✕ מסיר).</p>' +
      '<div style="display:flex;gap:24px;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:260px"><b>הוספת נבחן יחיד</b>' +
      '<label class="field" style="margin-top:10px"><span>שם</span><input id="add-name" type="text"></label>' +
      '<label class="field"><span>קוד אישי (לא חובה)</span><input id="add-code" type="text" placeholder="ריק = הנבחן בוחר בכניסה"></label>' +
      '<label class="field"><span>סבב ריאיון (לא חובה)</span><select id="add-iround"><option value="">— ללא —</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></label>' +
      '<div class="chips" id="add-subjects" style="margin-bottom:10px"></div>' +
      '<button class="btn small" id="add-one">הוסף נבחן</button></div>' +
      '<div style="flex:1;min-width:260px"><b>הוספת רשימה שלמה</b>' +
      '<p class="hint-text">שורה לכל נבחן: <span style="font-family:var(--mono)">שם</span> (הקוד לא חובה: <span style="font-family:var(--mono)">שם, קוד</span> או <span style="font-family:var(--mono)">שם, קוד, סבב</span>)</p>' +
      '<textarea id="bulk-text" placeholder="דנה כהן, 1234, 2&#10;יוסי לוי, 5678&#10;..." style="min-height:120px"></textarea>' +
      '<button class="btn small" id="add-bulk" style="margin-top:8px">הוסף רשימה</button></div>' +
      '<div style="flex:1;min-width:260px"><b>העלאת תכנון ריאיונות</b>' +
      '<p class="hint-text">שורה לכל נבחן: <span style="font-family:var(--mono)">קוד או שם, סבב</span> — יסמן מראש מי לריאיון בכל סבב.</p>' +
      '<textarea id="plan-text" placeholder="1234, 1&#10;דנה כהן, 2&#10;..." style="min-height:120px"></textarea>' +
      '<button class="btn small" id="plan-load" style="margin-top:8px">טען תכנון</button></div>' +
      '</div><div id="add-msg" style="margin-top:12px"></div></div>' +
      // גיבוי
      '<div class="card"><h2 class="section-title">גיבוי ושחזור</h2>' +
      '<p class="hint-text">המערכת מגבה אוטומטית כל 5 דקות (וגם לפני כל פעולת איפוס), גם בשרת. כאן אפשר לגבות עכשיו ולהוריד גיבוי.</p>' +
      '<div class="btn-row"><button class="btn small" id="btn-backup-now">גבה עכשיו</button></div>' +
      '<div id="backup-list" class="health-list" style="margin-top:12px"></div></div>' +
      // אזור מסוכן
      '<div class="card"><div class="toolbar"><h2 class="section-title">פעולות איפוס</h2><span class="spacer"></span>' +
      '<button class="btn ghost small" id="btn-danger-toggle">הצג</button></div>' +
      '<p class="hint-text">פעולות מוחקות — מוסתרות כברירת מחדל כדי שלא ילחצו עליהן בטעות. ' +
      'לסיום רגיל של היום השתמשו ב<b>«סיים מבחן»</b> ו<b>«סגור יום ושלח לבדיקה»</b> למעלה.</p>' +
      '<div id="danger-zone" style="display:none">' +
      '<div class="btn-row"><button class="btn ghost small" id="btn-full-reset">אפס יום מלא (לחזרה גנרלית)</button>' +
      '<button class="btn danger small" id="btn-remove-all">הסר את כל הנבחנים</button></div>' +
      '<p class="hint-text">"סיים את המבחן" מעביר את כל הנבחנים למסך סיום. "אפס יום מלא" מוחק את כל ההתקדמות והתשובות ומתחיל מאפס — שומר את רשימת הנבחנים והתכנון. <b>"הסר את כל הנבחנים"</b> מוחק לגמרי את כל הנבחנים והתשובות (משאיר רק את תכנון הסבבים). להשתמש רק לפני היום או אחרי חזרה גנרלית. לפני כל פעולה נוצר גיבוי אוטומטי.</p>' +
      '<div id="health"></div></div></div>' +
      '</div>'
    ));
    document.getElementById('btn-logout').onclick = function () { localStorage.removeItem('yh_examiner_token'); token = null; if (pollHandle) clearInterval(pollHandle); if (tickHandle) clearInterval(tickHandle); leave(); };
    document.getElementById('btn-roster').onclick = downloadRoster;
    document.getElementById('btn-excel').onclick = downloadExcel;
    document.getElementById('btn-export').onclick = downloadExport;
    document.getElementById('btn-grade').onclick = function () { location.href = '/grade'; };
    document.getElementById('btn-health').onclick = toggleHealth;
    document.getElementById('btn-backup-now').onclick = backupNow;
    document.getElementById('add-one').onclick = addOne;
    document.getElementById('add-bulk').onclick = addBulk;
    document.getElementById('plan-load').onclick = loadPlan;
    var dt = document.getElementById('btn-danger-toggle');
    if (dt) dt.onclick = function () {
      var z = document.getElementById('danger-zone');
      var open = z.style.display !== 'none';
      z.style.display = open ? 'none' : 'block';
      this.textContent = open ? 'הצג' : 'הסתר';
    };
    document.getElementById('btn-full-reset').onclick = fullReset;
    document.getElementById('btn-remove-all').onclick = removeAllExaminees;
    document.getElementById('btn-autosplit').onclick = autosplit;
    var mt = document.getElementById('btn-matrix-toggle');
    if (mt) mt.onclick = function () { matrixHidden = !matrixHidden; this.textContent = matrixHidden ? 'הצג' : 'הסתר'; refresh(); };
    renderAddSubjects();
  }

  // ברירת המחדל של הודעת מסך הסיום — זהה ל-DEFAULT_FINISH_MSG בשרת
  var DEFAULT_FINISH = 'המבחן הסתיים — תודה רבה! נא לעבור למשבצת הבאה לפי ההנחיות של הצוות.';

  // הודעת אישור צפה — כדי שתמיד יהיה ברור שהפעולה נשמרה
  function toast(msg, kind) {
    var t = document.getElementById('exm-toast');
    if (t && t.parentNode) t.remove();
    t = document.createElement('div');
    t.id = 'exm-toast';
    t.textContent = msg;
    var bg = kind === 'error' ? '#fb5c6b' : '#45b84e';
    var fg = kind === 'error' ? '#fff' : '#04220a';
    t.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:99999;background:' + bg +
      ';color:' + fg + ';font-weight:700;padding:11px 22px;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.45);font-size:15px;transition:opacity .4s';
    document.body.appendChild(t);
    setTimeout(function () { if (t) t.style.opacity = '0'; }, 2200);
    setTimeout(function () { if (t && t.parentNode) t.remove(); }, 2700);
  }

  // ------------------------------------------------- הקמת יום הערכה
  var DAYS = { days: [], active_day_id: null, min_rounds: 3, max_rounds: 5 };
  async function loadDays() {
    try { DAYS = await call('/examiner/days'); } catch (e) { /* לא לשבור */ }
    renderDaySetup();
  }
  // שורת שליטה קבועה: תמיד ברור באיזה יום עובדים ומה השלב שלו.
  function renderDaySetup() {
    var box = document.getElementById('day-setup'); if (!box) return;
    // הגנה: אם המנהל מקליד/בוחר כרגע בתוך הכרטיס — לא לרנדר מחדש (שלא יימחק לו)
    if (box.contains(document.activeElement) &&
        /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    var S = STATE || {};
    var day = S.day || null;
    if (!day) {
      box.innerHTML = '<div class="toolbar"><h2 class="section-title">יום הערכה</h2><span class="spacer"></span>' +
        '<button class="btn small" id="btn-new-day">+ הקם יום הערכה</button></div>' +
        '<p class="hint-text">עדיין לא הוקם יום הערכה. לחצו «הקם יום הערכה» כדי להתחיל.</p>';
      document.getElementById('btn-new-day').onclick = openDayModal;
      return;
    }
    var phase = day.phase === 'open' ? 'open' : 'registration';
    var n = day.total_rounds;
    var subjCount = S.subject_count || Math.max(1, n - 2);
    var started = (S.rounds || []).some(function (r) { return r.state !== 'planned'; });
    var meta = DAYS.days.filter(function (d) { return d.id === day.id; })[0] || {};
    // ⚠ day.status מגיע טרי מ-/examiner/status בכל רענון; meta מגיע ממטמון DAYS
    // ש-refresh() לא מרענן. הסדר ההפוך גרם למסך להציג «פתוח» אחרי שהיום נסגר.
    var closed = (day.status || meta.status) === 'closed';
    var ended = !!day.exam_ended;
    var phaseChip = closed
      ? '<span class="dc-chip closed">יום סגור · בארכיון</span>'
      : (ended ? '<span class="dc-chip ended">המבחן הסתיים</span>'
        : (phase === 'open' ? '<span class="dc-chip open">המבחן פתוח</span>'
          : '<span class="dc-chip reg">הרשמה בלבד</span>'));

    box.innerHTML =
      // ── שורת השליטה ──
      '<div class="day-ctl">' +
      '<div class="dc-main"><span class="dc-label">מפעיל כרגע</span>' +
      '<b class="dc-name">' + esc(day.name) + '</b>' + phaseChip + '</div>' +
      '<div class="dc-stats">' +
      '<span><small>נבחנים</small><b>' + (meta.examinees != null ? meta.examinees : (S.examinees || []).length) + '</b></span>' +
      '<span><small>סבבים</small><b>' + n + '</b></span>' +
      '<span><small>מקצועות לבחירה</small><b>' + subjCount + '</b></span>' +
      (meta.created_at ? '<span><small>הוקם</small><b style="font-size:14px">' + fmtDay(meta.created_at) + '</b></span>' : '') +
      '</div>' +
      '<div class="dc-actions">' +
      '<button class="btn ghost small" id="btn-days-list">כל הימים (' + DAYS.days.length + ')</button>' +
      '<button class="btn small" id="btn-new-day">+ הקם יום</button>' +
      '</div></div>' +

      // ── מחזור החיים של היום: התחל → סיים → סגור ──
      '<div class="lifecycle">' +
      '<div class="lc-step ' + (closed ? 'done' : (phase === 'open' ? 'done' : 'now')) + '">' +
      '<div class="lc-num">1</div><div class="lc-body"><b>התחל מבחן</b>' +
      '<small>נפתחים לנבחנים ההוראות, ההצהרה ובחירת המקצועות</small>' +
      (closed ? '' : (phase === 'registration'
        ? '<button class="btn big" id="btn-open-exam">התחל מבחן ▶</button>'
        : '<span class="lc-tag">בוצע ✓</span> <button class="btn ghost small" id="btn-close-reg">חזור לשלב הרשמה</button>')) +
      '</div></div>' +
      '<div class="lc-step ' + (closed ? 'done' : (ended ? 'done' : (phase === 'open' ? 'now' : ''))) + '">' +
      '<div class="lc-num">2</div><div class="lc-body"><b>סיים מבחן</b>' +
      '<small>כל הנבחנים עוברים למסך הסיום עם ההודעה שלמטה</small>' +
      (closed ? '' : (ended
        ? '<span class="lc-tag">בוצע ✓</span> <button class="btn ghost small" id="btn-reopen-exam">החזר לפעילות</button>'
        : (phase === 'open' ? '<button class="btn" id="btn-end-exam-top">סיים מבחן</button>' : ''))) +
      '</div></div>' +
      '<div class="lc-step ' + (closed ? 'done' : (ended ? 'now' : '')) + '">' +
      '<div class="lc-num">3</div><div class="lc-body"><b>סגור יום ושלח לבדיקה</b>' +
      '<small>יוצר את הצילום הראשי לבדיקה וסוגר את היום לארכיון</small>' +
      (closed
        ? '<span class="lc-tag">בוצע ✓ — היום בארכיון</span>'
        : (phase === 'open' ? '<button class="btn" id="btn-save-day">סגור יום ושלח לבדיקה ✓</button>' : '')) +
      '</div></div>' +
      '</div>' +
      (ended && !closed
        ? '<div class="msg info" style="margin-top:10px"><b>הנבחנים רואים כרגע:</b> «' + esc(day.finish_message || 'המבחן הסתיים — תודה רבה! נא לעבור למשבצת הבאה לפי ההנחיות של הצוות.') + '»</div>'
        : '') +

      // ── הגדרות היום: מופרד ל«קבוע» מול «ניתן לשינוי תמיד» ──
      '<div class="settings-block">' +
      '<div class="sb-head"><b>מבנה היום</b>' +
      (started ? '<span class="sb-lock">נעול — המבחן התחיל</span>' : '<span class="sb-open">ניתן לשינוי עד תחילת הסבב הראשון</span>') + '</div>' +
      '<div class="day-grid">' +
      '<label class="field" style="margin:0"><span>מספר סבבים</span>' +
      (started
        ? '<input type="text" value="' + n + ' סבבים" disabled>'
        : (function () {
            var o = '';
            for (var k = DAYS.min_rounds; k <= DAYS.max_rounds; k++) o += '<option value="' + k + '"' + (k === n ? ' selected' : '') + '>' + k + ' סבבים</option>';
            return '<select id="day-rounds">' + o + '</select>';
          })()) +
      '</label>' +
      '<div class="field" style="margin:0"><span>מה זה אומר</span>' +
      '<div class="sb-note" id="rounds-explain">' + n + ' סבבים = <b>' + subjCount + ' ' + (subjCount === 1 ? 'מקצוע' : 'מקצועות') + ' לבחירה</b> + «מידע כללי» + ריאיון</div></div>' +
      '</div>' +
      (started ? '<p class="hint-text" style="margin:6px 0 0">כדי לשבץ נבחן בודד לסבב שרץ: «כרטיס» → «קדם לפעילות הבאה».</p>' : '') +
      '</div>' +

      '<div class="settings-block">' +
      '<div class="sb-head"><b>טקסטים</b><span class="sb-open">ניתן לשינוי בכל עת, גם בזמן המבחן</span></div>' +
      '<div class="day-grid">' +
      '<label class="field" style="margin:0"><span>שם היום (לשימוש שלך)</span><input id="day-name" type="text" value="' + esc(day.name) + '"></label>' +
      '<label class="field" style="margin:0"><span>כותרת לנבחן (בדף הכניסה)</span><input id="day-title" type="text" value="' + esc(day.title || '') + '"></label>' +
      '</div>' +
      '<label class="field" style="margin-top:8px"><span>הודעה שהנבחן יראה במסך הסיום' +
      (ended ? ' <b style="color:var(--ok)">— מוצגת כרגע לנבחנים</b>' : '') + '</span>' +
      '<textarea id="day-finish" style="min-height:52px" placeholder="' + esc(DEFAULT_FINISH) + '">' + esc(day.finish_message || '') + '</textarea></label>' +
      '<p class="hint-text" style="margin:4px 0 0">אם משאירים ריק, יוצג: «' + esc(DEFAULT_FINISH) + '»</p>' +
      '<div class="btn-row" style="margin-top:8px"><button class="btn small" id="btn-save-details">שמור הגדרות</button>' +
      '<span class="hint-text" style="margin:0;align-self:center">שומר את כל השדות למעלה</span></div>' +
      '</div><div id="day-msg"></div>';

    // ⚠ כל חיווט חייב הגנת null — כפתורים קיימים רק במצבים מסוימים,
    // ושגיאה כאן עוצרת את כל הרינדור (טבלת נבחנים/קונסולה) בשקט.
    var nd = document.getElementById('btn-new-day');
    if (nd) nd.onclick = openDayModal;
    var dl = document.getElementById('btn-days-list');
    if (dl) dl.onclick = openDaysList;
    var og = document.getElementById('btn-open-exam');
    if (og) og.onclick = function () {
      if (!confirm('להתחיל את המבחן?\n\nהנבחנים שנרשמו יעברו למסך ההוראות, ההצהרה ובחירת המקצועות.')) return;
      saveDay({ phase: 'open' });
    };
    var cg = document.getElementById('btn-close-reg');
    if (cg) cg.onclick = function () {
      if (!confirm('לחזור לשלב הרשמה?\n\nהנבחנים יראו שוב את מסך «נרשמת בהצלחה». אפשר רק לפני שהתחיל סבב.')) return;
      saveDay({ phase: 'registration' });
    };
    var eb = document.getElementById('btn-end-exam-top');
    if (eb) eb.onclick = endExam;
    var rb = document.getElementById('btn-reopen-exam');
    if (rb) rb.onclick = async function () {
      if (!confirm('להחזיר את הנבחנים לפעילות? הם יצאו ממסך הסיום.')) return;
      try { await call('/examiner/end-exam', 'POST', { ended: false }); await refresh(); renderDaySaves(); toast('הוחזר לפעילות'); }
      catch (e) { alert(e.message); }
    };
    var sd = document.getElementById('btn-save-day');
    if (sd) sd.onclick = saveDayFinal;
    var sdet = document.getElementById('btn-save-details');
    if (sdet) sdet.onclick = function () { saveDay(); };
    var dr = document.getElementById('day-rounds');
    if (dr) dr.onchange = function () {
      var v = Number(this.value), sc = Math.max(1, v - 2);
      var ex2 = document.getElementById('rounds-explain');
      if (ex2) ex2.innerHTML = v + ' סבבים = <b>' + sc + ' ' + (sc === 1 ? 'מקצוע' : 'מקצועות') + ' לבחירה</b> + «מידע כללי» + ריאיון<br><span style="color:var(--warn)">לחצו «שמור הגדרות» כדי להחיל.</span>';
    };
  }
  function fmtDay(ms) { try { return new Date(ms).toLocaleDateString('he-IL'); } catch (e) { return ''; } }
  function fmtWhenFull(ms) { try { return new Date(ms).toLocaleString('he-IL'); } catch (e) { return ''; } }

  // ------------------------------------------------- «שמור יום» + מה נשמר
  async function saveDayFinal() {
    if (!confirm('לשמור ולסגור את היום?\n\n• כל הנבחנים יעברו למסך הסיום\n• ייווצר הצילום הראשי לבדיקה (עותק קפוא של כל התשובות)\n• היום יעבור לארכיון — הנתונים יישארו נגישים במלואם')) return;
    try {
      var r = await call('/examiner/save-day', 'POST', {});
      await loadDays(); await refresh(); renderDaySaves();
      showSaveResult(r);
      toast('היום נשמר ✓ — ' + r.examinees + ' נבחנים, ' + r.answers + ' תשובות');
    } catch (e) { alert('השמירה לא הושלמה: ' + e.message); }
  }

  function showSaveResult(r) {
    var m = document.getElementById('save-modal');
    if (!m) { m = el('<div class="modal-back" id="save-modal"></div>'); document.body.appendChild(m); }
    m.onclick = function (ev) { if (ev.target === m) m.remove(); };
    m.innerHTML = '<div class="modal-card" style="max-width:560px">' +
      '<h2 style="margin:0 0 6px;font-size:20px">היום נשמר ✓</h2>' +
      '<p class="hint-text">היום «' + esc(r.day_name) + '» נסגר, וכל התשובות הועברו לצילום קפוא לבדיקה.</p>' +
      '<div class="save-sum">' +
      '<span><small>נבחנים</small><b>' + r.examinees + '</b></span>' +
      '<span><small>תשובות</small><b>' + r.answers + '</b></span>' +
      '<span><small>שאלות «למד» לבדיקה</small><b>' + r.teachItems + '</b></span>' +
      '</div>' +
      '<div class="msg info" style="margin-top:12px"><b>איפה זה נשמר:</b> הצילום «' + esc(r.cohort_name) + '» נמצא ב<b>מסך הבדיקה</b>. ' +
      'הוא עותק <b>קפוא ונפרד</b> מנתוני היום — הוא לא ישתנה ולא ייעלם, גם אם תמחק את היום עצמו.</div>' +
      '<div class="btn-row"><button class="btn" id="sv-grade">פתח את מסך הבדיקה</button>' +
      '<button class="btn ghost" id="sv-xls">הורד Excel</button>' +
      '<button class="btn ghost" id="sv-x">סגור</button></div></div>';
    document.getElementById('sv-x').onclick = function () { m.remove(); };
    document.getElementById('sv-grade').onclick = function () { location.href = '/grade'; };
    document.getElementById('sv-xls').onclick = function () { downloadExcel(); };
  }

  async function renderDaySaves() {
    var box = document.getElementById('day-saves'); if (!box) return;
    var d;
    try { d = await call('/examiner/day-saves'); } catch (e) { box.innerHTML = ''; return; }
    var p = d.primary;
    var extra = (d.cohorts || []).filter(function (c) { return !c.is_primary; });
    var closedDays = (DAYS.days || []).filter(function (x) { return x.status === 'closed'; });
    box.innerHTML = '<div class="card saves-card ' + (p ? 'ok' : '') + '">' +
      '<div class="toolbar"><h2 class="section-title">מה נשמר מהיום הזה</h2><span class="spacer"></span>' +
      (p ? '<span class="rd-badge ok">צילום ראשי קיים ✓</span>' : '<span class="rd-badge">עדיין לא נשמר צילום ראשי</span>') + '</div>' +
      '<div class="rd-row"><span class="rd-dot ok"></span><span><b>נתוני היום (חי):</b> ' +
      d.live.examinees + ' נבחנים · ' + d.live.answers + ' תשובות — שמורים בבסיס הנתונים על הדיסק הקבוע של השרת, מופרדים לפי יום.</span></div>' +
      '<div class="rd-row"><span class="rd-dot ' + (p ? (d.stale ? 'warn' : 'ok') : 'warn') + '"></span><span><b>צילום לבדיקה:</b> ' +
      (p ? '«' + esc(p.name) + '» נשמר ב-' + fmtWhenFull(p.created_at) + ' · ' + p.examinees + ' נבחנים · ' + p.answers + ' תשובות'
         : 'טרם נוצר. לחצו «שמור יום» בסוף היום — או «צלם מצב» במסך הבדיקה בכל רגע.') + '</span></div>' +
      // ⚠ תשובות שהגיעו אחרי הצילום (טלפון שחזר לרשת) לא ינוקדו לעולם.
      // קודם שני המספרים הוצגו זה לצד זה בירוק, בלי שאף אחד ישווה ביניהם.
      (d.stale
        ? '<div class="msg error" style="margin:10px 0 0"><b>⚑ הצילום לא מעודכן.</b> הגיעו ' +
          d.stale_answers + ' תשובות' + (d.stale_examinees ? ' ו-' + d.stale_examinees + ' נבחנים' : '') +
          ' <b>אחרי</b> שהיום נסגר — הן קיימות בנתוני היום אבל <b>לא בצילום, ולכן לא ינוקדו</b>. ' +
          'לחצו «צלם שוב לבדיקה» כדי לכלול אותן.' +
          '<div class="btn-row" style="margin-top:10px"><button class="btn small" id="sv-resnap">צלם שוב לבדיקה</button></div></div>'
        : '') +
      (extra.length ? '<div class="rd-row"><span class="rd-dot"></span><span>צילומים נוספים: ' + extra.length + ' (' + extra.map(function (c) { return esc(c.name); }).join(', ') + ')</span></div>' : '') +
      '<p class="hint-text" style="margin-top:8px">הצילום הוא <b>עותק קפוא ונפרד</b> של התשובות — ממנו בודקים ונותנים ציונים. הוא שורד גם אם היום החי יימחק.</p>' +
      '<div class="btn-row"><button class="btn small" id="sv-open-grade">פתח את מסך הבדיקה</button>' +
      '<button class="btn ghost small" id="sv-dl-xls">הורד Excel של היום</button>' +
      '<button class="btn ghost small" id="sv-dl-json">הורד JSON</button></div></div>' +
      // ── ארכיון: כל הימים הסגורים, להורדה מהירה ──
      (closedDays.length
        ? '<div class="card"><div class="toolbar"><h2 class="section-title">ארכיון — ימים סגורים (' + closedDays.length + ')</h2>' +
          '<span class="spacer"></span><button class="btn small" id="ar-all">הורד הכול (חוברת אחת)</button></div>' +
          '<p class="hint-text">כל יום שנסגר נשמר כאן. «הורד הכול» מוריד חוברת Excel אחת עם <b>גיליון לכל יום</b>.</p>' +
          '<div class="arch-list">' + closedDays.map(function (d) {
            return '<div class="arch-row"><div><b>' + esc(d.name) + '</b>' +
              '<div style="font-size:12px;color:var(--muted)">' + fmtDay(d.created_at) + ' · ' + d.examinees + ' נבחנים · ' + d.total_rounds + ' סבבים' +
              (d.has_snapshot ? ' · <span class="ok">נשמר לבדיקה ✓</span>' : ' · <span style="color:var(--warn)">בלי צילום בדיקה</span>') + '</div></div>' +
              '<div style="display:flex;gap:6px"><button class="btn small ar-xls" data-id="' + d.id + '">הורד Excel</button>' +
              '<button class="btn ghost small ar-json" data-id="' + d.id + '">JSON</button></div></div>';
          }).join('') + '</div></div>'
        : '');
    // ⚠ תמיד עם הגנת null — אלמנט חסר שובר את כל הרינדור (ראו CLAUDE.md)
    var og = document.getElementById('sv-open-grade'); if (og) og.onclick = function () { location.href = '/grade'; };
    var dx = document.getElementById('sv-dl-xls'); if (dx) dx.onclick = downloadExcel;
    var dj = document.getElementById('sv-dl-json'); if (dj) dj.onclick = downloadExport;
    var rs = document.getElementById('sv-resnap');
    if (rs) rs.onclick = async function () {
      rs.disabled = true; rs.textContent = 'מצלם…';
      try {
        var r = await call('/examiner/grading/snapshot', 'POST', { name: ((d.day && d.day.name) || 'יום') + ' — מעודכן' });
        alert('נוצר צילום מעודכן: ' + r.examinees + ' נבחנים · ' + r.answers + ' תשובות.\n\nשימו לב: הצילום החדש אינו מסומן «ראשי». במסך הבדיקה בחרו אותו.');
        refresh();
      } catch (e) { alert(e.message); rs.disabled = false; rs.textContent = 'צלם שוב לבדיקה'; }
    };
    var arAll = document.getElementById('ar-all');
    if (arAll) arAll.onclick = function () {
      downloadBlob('/examiner/export-excel?all_closed=1', 'all-closed-days.xlsx').catch(function (e) { alert(e.message); });
    };
    box.querySelectorAll('.ar-xls').forEach(function (b) {
      b.onclick = function () { downloadBlob('/examiner/export-excel?day_id=' + b.getAttribute('data-id'), 'answers-day' + b.getAttribute('data-id') + '.xlsx').catch(function (e) { alert(e.message); }); };
    });
    box.querySelectorAll('.ar-json').forEach(function (b) {
      b.onclick = function () { downloadBlob('/examiner/export-all?day_id=' + b.getAttribute('data-id'), 'day' + b.getAttribute('data-id') + '.json').catch(function (e) { alert(e.message); }); };
    });
  }


  // ------------------------------------------------- מודאל: הקמת יום
  function openDayModal() {
    var m = document.getElementById('day-modal');
    if (!m) { m = el('<div class="modal-back" id="day-modal"></div>'); document.body.appendChild(m); }
    m.onclick = function (ev) { if (ev.target === m) m.remove(); };
    var opts = '';
    for (var k = DAYS.min_rounds; k <= DAYS.max_rounds; k++) opts += '<option value="' + k + '"' + (k === 5 ? ' selected' : '') + '>' + k + ' סבבים</option>';
    m.innerHTML = '<div class="modal-card" style="max-width:520px">' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:4px"><h2 style="margin:0;font-size:20px">הקמת יום הערכה</h2>' +
      '<span style="flex:1"></span><button class="btn ghost small" id="dm-x">סגור</button></div>' +
      '<p class="hint-text">היום החדש יהיה ריק ויהפוך ליום שאת/ה מפעיל/ה. <b>נתוני הימים הקודמים נשמרים במלואם</b> ולא נמחקים.</p>' +
      '<label class="field"><span>שם היום (לשימוש שלך)</span><input id="dm-name" type="text" value="בחינת סיווג ' + new Date().toLocaleDateString('he-IL') + '"></label>' +
      '<label class="field"><span>כותרת שהנבחן רואה בדף הכניסה</span><input id="dm-title" type="text" value="בחינת סיווג תשפ״ז"></label>' +
      '<label class="field"><span>מספר סבבים</span><select id="dm-rounds">' + opts + '</select></label>' +
      '<p class="hint-text" id="dm-explain"></p>' +
      '<div id="dm-msg"></div>' +
      '<div class="btn-row"><button class="btn" id="dm-go">צור יום</button>' +
      '<button class="btn ghost" id="dm-cancel">ביטול</button></div></div>';
    function explain() {
      var v = Number(document.getElementById('dm-rounds').value), sc = Math.max(1, v - 2);
      document.getElementById('dm-explain').innerHTML = v + ' סבבים = <b>' + sc + ' ' + (sc === 1 ? 'מקצוע' : 'מקצועות') + ' שהנבחן בוחר</b> + פרק «מידע כללי» (חובה לכולם) + ריאיון אישי.' +
        '<br><span style="color:var(--muted)">שימו לב: מראיין אחד מראיין נבחן אחד בסבב, לכן צריך לפחות ⌈נבחנים ÷ ' + v + '⌉ מראיינים.</span>';
    }
    explain();
    document.getElementById('dm-rounds').onchange = explain;
    document.getElementById('dm-x').onclick = function () { m.remove(); };
    document.getElementById('dm-cancel').onclick = function () { m.remove(); };
    document.getElementById('dm-go').onclick = async function () {
      var name = document.getElementById('dm-name').value.trim();
      var title = document.getElementById('dm-title').value.trim();
      var rounds = Number(document.getElementById('dm-rounds').value);
      if (!name) { document.getElementById('dm-msg').innerHTML = '<div class="msg error">יש למלא שם ליום.</div>'; return; }
      try {
        await call('/examiner/create-day', 'POST', { name: name, title: title, total_rounds: rounds });
        m.remove();
        await loadDays(); await refresh(); loadInterviewers();
        toast('נוצר יום «' + name + '» — והוא כעת היום הפעיל ✓');
      } catch (e) { document.getElementById('dm-msg').innerHTML = '<div class="msg error">' + esc(e.message) + '</div>'; }
    };
  }

  // ------------------------------------------------- מודאל: כל הימים
  async function openDaysList() {
    await loadDays();
    var m = document.getElementById('days-modal');
    if (!m) { m = el('<div class="modal-back" id="days-modal"></div>'); document.body.appendChild(m); }
    m.onclick = function (ev) { if (ev.target === m) m.remove(); };
    var rows = DAYS.days.map(function (d) {
      var isActive = d.id === DAYS.active_day_id;
      var status = isActive ? '<span class="dc-chip open">מפעיל כרגע</span>'
        : (d.status === 'closed' ? '<span class="dc-chip closed">סגור</span>' : '<span class="dc-chip">פתוח</span>');
      return '<tr>' +
        '<td><b>' + esc(d.name) + '</b>' + (d.title ? '<div style="font-size:12px;color:var(--muted)">' + esc(d.title) + '</div>' : '') + '</td>' +
        '<td>' + fmtDay(d.created_at) + '</td>' +
        '<td style="text-align:center">' + d.examinees + '</td>' +
        '<td style="text-align:center">' + d.total_rounds + '</td>' +
        '<td>' + status + '</td>' +
        '<td class="dl-actions">' +
        (isActive ? '' : '<button class="btn small dl-use" data-id="' + d.id + '">נהל</button>') +
        '<button class="btn ghost small dl-xls" data-id="' + d.id + '">Excel</button>' +
        '<button class="btn ghost small dl-json" data-id="' + d.id + '">JSON</button>' +
        (d.status === 'closed'
          ? '<button class="btn ghost small dl-open" data-id="' + d.id + '">פתח מחדש</button>'
          : '<button class="btn ghost small dl-close" data-id="' + d.id + '">סגור יום</button>') +
        '<button class="btn danger small dl-del" data-id="' + d.id + '" data-n="' + esc(d.name) + '">מחק</button>' +
        '</td></tr>';
    }).join('');
    m.innerHTML = '<div class="modal-card" style="max-width:900px">' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:4px"><h2 style="margin:0;font-size:20px">כל ימי ההערכה</h2>' +
      '<span style="flex:1"></span><button class="btn small" id="dl-new">+ הקם יום</button>' +
      '<button class="btn ghost small" id="dl-x">סגור</button></div>' +
      '<p class="hint-text">«נהל» מחליף את היום שאת/ה מפעיל/ה — <b>כל המסך מתחלף</b> (נבחנים, סבבים, ייצואים). ' +
      '«סגור יום» מעביר לארכיון והנתונים נשארים נגישים במלואם. ' +
      '«מחק» מוחק את נתוני היום — <b>אבל צילומי המצב במסך הבדיקה נשמרים</b>, כך שציונים שהופקו לא נעלמים.</p>' +
      '<div style="overflow-x:auto"><table class="grid"><thead><tr>' +
      '<th>שם היום</th><th>הוקם</th><th>נבחנים</th><th>סבבים</th><th>סטטוס</th><th>פעולות</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div><div id="dl-msg" style="margin-top:10px"></div></div>';

    document.getElementById('dl-x').onclick = function () { m.remove(); };
    document.getElementById('dl-new').onclick = function () { m.remove(); openDayModal(); };
    m.querySelectorAll('.dl-use').forEach(function (b) {
      b.onclick = function () { m.remove(); switchDay(Number(b.getAttribute('data-id'))); };
    });
    m.querySelectorAll('.dl-xls').forEach(function (b) {
      b.onclick = function () { downloadBlob('/examiner/export-excel?day_id=' + b.getAttribute('data-id'), 'answers-day' + b.getAttribute('data-id') + '.xlsx').catch(function (e) { alert(e.message); }); };
    });
    m.querySelectorAll('.dl-json').forEach(function (b) {
      b.onclick = function () { downloadBlob('/examiner/export-all?day_id=' + b.getAttribute('data-id'), 'day' + b.getAttribute('data-id') + '.json').catch(function (e) { alert(e.message); }); };
    });
    m.querySelectorAll('.dl-close').forEach(function (b) {
      b.onclick = async function () {
        if (!confirm('לסגור את היום?\n\nהוא יעבור לארכיון. הנתונים נשארים נגישים במלואם ותמיד אפשר לפתוח מחדש.')) return;
        try { await call('/examiner/set-day-status', 'POST', { day_id: Number(b.getAttribute('data-id')), status: 'closed' }); openDaysList(); refresh(); }
        catch (e) { alert(e.message); }
      };
    });
    m.querySelectorAll('.dl-open').forEach(function (b) {
      b.onclick = async function () {
        try { await call('/examiner/set-day-status', 'POST', { day_id: Number(b.getAttribute('data-id')), status: 'open' }); openDaysList(); refresh(); }
        catch (e) { alert(e.message); }
      };
    });
    m.querySelectorAll('.dl-del').forEach(function (b) {
      b.onclick = async function () {
        var nm = b.getAttribute('data-n');
        if (!confirm('למחוק את היום «' + nm + '»?\n\nיימחקו הנבחנים, התשובות, המשבצות והמראיינים של היום הזה.\nצילומי המצב במסך הבדיקה (ציונים) יישמרו.')) return;
        if (!confirm('בטוח לגמרי? אי אפשר לבטל.\n\n(נוצר גיבוי אוטומטי לפני המחיקה.)')) return;
        try {
          var r = await call('/examiner/delete-day', 'POST', { day_id: Number(b.getAttribute('data-id')) });
          await loadDays(); openDaysList(); refresh(); loadInterviewers();
          toast('היום «' + nm + '» נמחק (' + r.removed_examinees + ' נבחנים)');
        } catch (e) { document.getElementById('dl-msg').innerHTML = '<div class="msg error">' + esc(e.message) + '</div>'; }
      };
    });
  }

  async function switchDay(id) {
    try {
      await call('/examiner/set-active-day', 'POST', { day_id: id });
      await loadDays(); await refresh(); loadInterviewers();
      var d = DAYS.days.filter(function (x) { return x.id === id; })[0];
      toast('עברת לנהל את «' + (d ? d.name : 'היום') + '»');
    } catch (e) { alert(e.message); }
  }
  async function saveDay(extra) {
    // חסינות: אם בטעות הועבר אירוע לחיצה (onclick = saveDay) — להתעלם ממנו
    // ולקרוא את השדות מהמסך, אחרת השינויים לא נשמרים.
    if (extra && (extra instanceof Event || extra.target || extra.currentTarget)) extra = null;
    var body = {};
    if (extra && extra.phase != null) {
      // פעולת שלב ממוקדת (התחל/סיים מבחן) — לא נוגעים בשדות הטופס
      body = extra;
    } else {
      // כפתור «שמור פרטי יום» — שומר את כל השדות שקיימים במסך
      var fN = document.getElementById('day-name');
      var fT = document.getElementById('day-title');
      var fR = document.getElementById('day-rounds');
      var fF = document.getElementById('day-finish');
      if (fN) body.name = fN.value;
      if (fT) body.title = fT.value;
      if (fR) body.total_rounds = Number(fR.value);
      if (fF) body.finish_message = fF.value;
      if (extra) { for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k]; }
    }
    var msg = document.getElementById('day-msg');
    try {
      await call('/examiner/update-day', 'POST', body);
      if (msg) msg.innerHTML = '';
      if (body.phase == null) toast('פרטי היום נשמרו ✓');
      await loadDays(); await refresh(); renderDaySaves();
    } catch (e) {
      if (msg) msg.innerHTML = '<div class="msg error">' + esc(e.message) + '</div>'; else alert(e.message);
      await loadDays();
    }
  }

  // ------------------------------------------------- בקשות החלפה מהמראיינים
  async function renderSwaps(S) {
    var box = document.getElementById('swaps'); if (!box) return;
    if (!S || !S.pending_swaps) { box.innerHTML = ''; return; }
    var reqs;
    try { reqs = (await call('/examiner/swap-requests')).requests || []; } catch (e) { return; }
    var pending = reqs.filter(function (r) { return r.status === 'pending'; });
    if (!pending.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="card swaps-card">' +
      '<div class="toolbar"><h2 class="section-title">בקשות החלפה מהמראיינים <span class="rd-badge">' + pending.length + ' ממתינות</span></h2></div>' +
      '<p class="hint-text">המראיין מבקש — אתם מאשרים. אישור מבצע את השינוי בפועל (אם ציינתם סבב/מראיין חדשים).</p>' +
      pending.map(function (r) {
        var rounds = '';
        for (var n = 1; n <= S.total_rounds; n++) rounds += '<option value="' + n + '"' + (n === r.round ? ' selected' : '') + '>סבב ' + n + '</option>';
        var ivs = '<option value="">— בלי שינוי מראיין —</option>' + (S.interviewers || []).map(function (v) {
          return '<option value="' + v.id + '">' + esc(v.name) + (v.room ? ' · ' + esc(v.room) : '') + '</option>';
        }).join('');
        return '<div class="swap-row">' +
          '<div><b>' + esc(r.interviewer_name || '—') + '</b>' + (r.room ? ' <small style="color:var(--muted)">' + esc(r.room) + '</small>' : '') +
          '<div style="font-size:13px;color:var(--muted);margin-top:3px">' + esc(r.requested_change) + '</div></div>' +
          '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
          '<select class="sw-round" data-id="' + r.id + '">' + rounds + '</select>' +
          '<select class="sw-iv" data-id="' + r.id + '">' + ivs + '</select>' +
          '<button class="btn small sw-ok" data-id="' + r.id + '">אשר</button>' +
          '<button class="btn ghost small sw-no" data-id="' + r.id + '">דחה</button>' +
          '</div></div>';
      }).join('') + '</div>';
    box.querySelectorAll('.sw-ok').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-id');
        var rd = box.querySelector('.sw-round[data-id="' + id + '"]').value;
        var iv = box.querySelector('.sw-iv[data-id="' + id + '"]').value;
        var body = { id: Number(id), approve: true, new_round: Number(rd) };
        if (iv) body.new_interviewer_id = Number(iv);
        call('/examiner/decide-swap', 'POST', body).then(function () { refresh(); loadInterviewers(); }).catch(function (e) { alert(e.message); });
      };
    });
    box.querySelectorAll('.sw-no').forEach(function (b) {
      b.onclick = function () {
        call('/examiner/decide-swap', 'POST', { id: Number(b.getAttribute('data-id')), approve: false })
          .then(function () { refresh(); }).catch(function (e) { alert(e.message); });
      };
    });
  }

  // ------------------------------------------------- פס מוכנות
  function renderReadiness(S) {
    var box = document.getElementById('readiness'); if (!box) return;
    var R = S && S.readiness; if (!R) { box.innerHTML = ''; return; }
    var items = [];
    var okAll = R.all_have_interview && R.all_have_interviewer && R.rounds_ok &&
      !R.interviewers_without_room.length && R.capacity_ok !== false && !(R.double_booked || []).length;
    items.push({ ok: R.rounds_ok, txt: 'מספר סבבים תקין (' + S.total_rounds + ')' });
    // קיבולת מראיינים — מראיין אחד מראיין נבחן אחד בסבב
    if (R.capacity != null) {
      items.push({
        ok: R.capacity_ok !== false,
        txt: R.capacity_ok === false
          ? 'אין מספיק מראיינים: ' + R.total + ' נבחנים ב-' + S.total_rounds + ' סבבים דורשים לפחות ' + R.needed_interviewers + ' מראיינים (יש ' + R.interviewers + ')'
          : 'קיבולת מראיינים בסדר: ' + R.interviewers + ' מראיינים × ' + S.total_rounds + ' סבבים = ' + R.capacity + ' מקומות ל-' + R.total + ' נבחנים',
      });
    }
    if ((R.double_booked || []).length) {
      items.push({ ok: false, txt: 'חפיפת חדרים! אותו מראיין לשני נבחנים: ' + R.double_booked.join(' · ') });
    }
    items.push({
      ok: R.all_have_interview,
      txt: 'שובצו לריאיון: ' + R.interview_assigned + ' מתוך ' + R.total,
      more: R.missing_interview.length ? 'חסרים: ' + R.missing_interview.slice(0, 8).join(', ') + (R.missing_interview.length > 8 ? ' ועוד…' : '') : '',
    });
    items.push({
      ok: R.all_have_interviewer,
      txt: 'שובץ מראיין: ' + R.interviewer_assigned + ' מתוך ' + R.total,
      more: R.missing_interviewer.length ? 'בלי מראיין: ' + R.missing_interviewer.slice(0, 8).join(', ') + (R.missing_interviewer.length > 8 ? ' ועוד…' : '') : '',
    });
    if (R.interviewers_without_room.length) items.push({ ok: false, txt: 'מראיינים בלי חדר: ' + R.interviewers_without_room.join(', ') });
    if (R.self_registered.length) items.push({ ok: false, warn: true, txt: 'נרשמו בשם שאינו ברשימה (לבדוק): ' + R.self_registered.join(', ') });
    if ((R.no_subjects || []).length) items.push({ ok: false, warn: true, txt: 'טרם בחרו מקצועות (' + R.no_subjects.length + '): ' + R.no_subjects.slice(0, 8).join(', ') + (R.no_subjects.length > 8 ? ' ועוד…' : '') + ' — לא חוסם ריאיון' });
    box.innerHTML = '<div class="card readiness ' + (okAll ? 'ok' : '') + '">' +
      '<div class="rd-head">' + (okAll ? '<span class="rd-badge ok">הכול מוכן ✓</span>' : '<span class="rd-badge">בדיקת מוכנות</span>') + '</div>' +
      items.map(function (it) {
        return '<div class="rd-row"><span class="rd-dot ' + (it.ok ? 'ok' : (it.warn ? 'warn' : 'bad')) + '"></span>' +
          '<span>' + esc(it.txt) + (it.more ? ' <small style="color:var(--muted)">· ' + esc(it.more) + '</small>' : '') + '</span></div>';
      }).join('') + '</div>';
  }

  // ------------------------------------------------- מראיינים וחדרים
  var IVS = [];
  async function loadInterviewers() {
    try { IVS = (await call('/examiner/interviewers')).interviewers || []; } catch (e) { IVS = []; }
    renderInterviewers();
  }
  function renderInterviewers() {
    var box = document.getElementById('interviewers'); if (!box) return;
    var rows = IVS.map(function (v) {
      return '<tr><td><input class="iv-name" data-id="' + v.id + '" value="' + esc(v.name) + '"></td>' +
        '<td><input class="iv-room" data-id="' + v.id + '" value="' + esc(v.room) + '" placeholder="למשל: חדר 101"></td>' +
        '<td style="text-align:center">' + v.load + '</td>' +
        '<td><button class="btn ghost small iv-save" data-id="' + v.id + '">שמור</button> ' +
        '<button class="btn ghost small iv-del" data-id="' + v.id + '">✕</button></td></tr>';
    }).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--faint);padding:18px">אין מראיינים. הוסיפו למטה — כל מראיין יושב בחדר קבוע.</td></tr>';
    box.innerHTML =
      '<div class="toolbar"><h2 class="section-title">מראיינים וחדרים</h2><span class="spacer"></span>' +
      '<span class="hint-text" style="margin:0">מראיין = חדר קבוע. הנבחן רואה את השם והחדר בזמן הריאיון. <b>לאחר עריכת שם/חדר — לחצו «שמור».</b></span></div>' +
      '<table class="grid"><thead><tr><th>שם המראיין/ת</th><th>חדר</th><th>ריאיונות</th><th>פעולות</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:14px">' +
      '<div style="flex:1;min-width:240px"><b>הוספת מראיין</b>' +
      '<label class="field" style="margin-top:8px"><span>שם</span><input id="iv-add-name" type="text"></label>' +
      '<label class="field"><span>חדר</span><input id="iv-add-room" type="text" placeholder="למשל: חדר 101"></label>' +
      '<button class="btn small" id="iv-add">הוסף מראיין</button></div>' +
      '<div style="flex:1;min-width:240px"><b>הוספת רשימה</b>' +
      '<p class="hint-text">שורה לכל מראיין: <span style="font-family:var(--mono)">שם, חדר</span></p>' +
      '<textarea id="iv-bulk" placeholder="רות מזרחי, חדר 101&#10;אבי דגן, חדר 102" style="min-height:90px"></textarea>' +
      '<button class="btn small" id="iv-bulk-add" style="margin-top:8px">הוסף רשימה</button></div>' +
      '</div>' +
      (IVS.length ? '<div class="btn-row" style="margin-top:12px"><button class="btn danger small" id="iv-clear">הסר את כל המראיינים</button></div>' : '') +
      '<div id="iv-msg" style="margin-top:10px"></div>';

    document.getElementById('iv-add').onclick = async function () {
      var name = document.getElementById('iv-add-name').value.trim();
      var room = document.getElementById('iv-add-room').value.trim();
      if (!name) return;
      try {
        await call('/examiner/add-interviewer', 'POST', { name: name, room: room });
        toast('נוסף: ' + name + (room ? ' · ' + room : ''));
        loadInterviewers(); refresh();
      } catch (e) { document.getElementById('iv-msg').innerHTML = '<div class="msg error">' + esc(e.message) + '</div>'; }
    };
    document.getElementById('iv-bulk-add').onclick = async function () {
      var text = document.getElementById('iv-bulk').value;
      if (!text.trim()) return;
      try { var r = await call('/examiner/add-interviewers-bulk', 'POST', { text: text });
        document.getElementById('iv-msg').innerHTML = '<div class="msg info">נוספו ' + r.added + '.</div>';
        toast('נוספו ' + r.added + ' מראיינים');
        document.getElementById('iv-bulk').value = ''; loadInterviewers(); refresh();
      } catch (e) { document.getElementById('iv-msg').innerHTML = '<div class="msg error">' + esc(e.message) + '</div>'; }
    };
    var clr = document.getElementById('iv-clear');
    if (clr) clr.onclick = async function () {
      if (!confirm('להסיר את כל המראיינים של היום?\n\nהשיבוצים שלהם יתרוקנו (סימוני הריאיון בסבבים יישמרו).')) return;
      if (!confirm('בטוח? אי אפשר לבטל.')) return;
      try { var r = await call('/examiner/remove-all-interviewers', 'POST', {}); loadInterviewers(); refresh(); toast('הוסרו ' + r.removed + ' מראיינים'); }
      catch (e) { alert(e.message); }
    };
    box.querySelectorAll('.iv-save').forEach(function (b) {
      b.onclick = async function () {
        var id = b.getAttribute('data-id');
        var name = box.querySelector('.iv-name[data-id="' + id + '"]').value;
        var room = box.querySelector('.iv-room[data-id="' + id + '"]').value;
        try {
          await call('/examiner/edit-interviewer', 'POST', { id: Number(id), name: name, room: room });
          toast('נשמר ✓ ' + name + (room ? ' · ' + room : ''));
          loadInterviewers(); refresh();
        } catch (e) { toast(e.message, 'error'); }
      };
    });
    box.querySelectorAll('.iv-del').forEach(function (b) {
      b.onclick = async function () {
        if (!confirm('להסיר את המראיין/ת?')) return;
        try { await call('/examiner/remove-interviewer', 'POST', { id: Number(b.getAttribute('data-id')) }); loadInterviewers(); refresh(); }
        catch (e) { alert(e.message); }
      };
    });
  }

  // ------------------------------------------------- העלאת בריפים
  var BRIEF_PROMPT = 'מצורפת טבלה מאקסל עם נתונים על מועמדים לבחינת סיווג.\n' +
    'החזר/י שורה אחת לכל מועמד, בפורמט המדויק הזה ובלי שום טקסט נוסף:\n' +
    'שם מלא | בריף\n\n' +
    'הבריף: עד שני משפטים, בעברית, שמסכמים מה שחשוב שהמראיין ידע לפני הריאיון ' +
    '(רקע, נקודות חוזק, ועל מה כדאי לשים לב). בלי כותרות, בלי מספור, בלי שורות ריקות.';

  function renderBriefs() {
    var box = document.getElementById('briefs'); if (!box) return;
    if (box.contains(document.activeElement) &&
        /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    box.innerHTML =
      '<div class="toolbar"><h2 class="section-title">בריפים למראיינים</h2><span class="spacer"></span>' +
      '<button class="btn small" id="bf-control">בקרת בריפים</button>' +
      '<button class="btn ghost small" id="bf-copy">העתק פרומפט לקלוד</button></div>' +
      '<p class="hint-text">כל מראיין רואה בריף קצר על כל מי שהוא מראיין. הדרך המהירה: שלחו לקלוד את טבלת האקסל שלכם עם הפרומפט המוכן (כפתור «העתק פרומפט»), והדביקו כאן את התשובה.</p>' +
      '<div class="bf-prompt" id="bf-prompt-box">' + esc(BRIEF_PROMPT).replace(/\n/g, '<br>') + '</div>' +
      '<label class="field" style="margin-top:10px"><span>הדביקו כאן: שורה לכל נבחן — <span style="font-family:var(--mono)">שם | בריף</span> (עובד גם עם טאב או פסיק, והדבקה ישירה מאקסל)</span>' +
      '<textarea id="bf-text" style="min-height:120px" placeholder="דנה לוי | מורה פרטית שנתיים, חזקה במתמטיקה. לבדוק התמודדות עם כיתה גדולה.&#10;יוסי כהן | רקע בהנדסה, בלי ניסיון הוראה. לבדוק סבלנות והנגשה."></textarea></label>' +
      '<div class="btn-row"><button class="btn small" id="bf-go">עדכן בריפים</button></div>' +
      '<div id="bf-msg" style="margin-top:10px"></div>';

    document.getElementById('bf-control').onclick = openBriefsControl;
    document.getElementById('bf-copy').onclick = function () {
      var done = function () { toast('הפרומפט הועתק — שלחו אותו לקלוד עם טבלת האקסל'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(BRIEF_PROMPT).then(done).catch(function () { selectPrompt(); });
      } else selectPrompt();
    };
    function selectPrompt() {
      var el2 = document.getElementById('bf-prompt-box');
      if (!el2) return;
      var rng = document.createRange(); rng.selectNodeContents(el2);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rng);
      toast('סמנו והעתיקו (Cmd+C)');
    }
    document.getElementById('bf-go').onclick = async function () {
      var text = document.getElementById('bf-text').value;
      var msg = document.getElementById('bf-msg');
      if (!text.trim()) { msg.innerHTML = '<div class="msg error">אין מה לעדכן — הדביקו קודם.</div>'; return; }
      try {
        var r = await call('/examiner/set-briefs-bulk', 'POST', { text: text });
        var html = '<div class="msg info">שויכו ' + r.updated + ' בריפים (התאמת שם מדויקת).</div>';
        if ((r.suggested || []).length) html += '<div class="msg warn">' + r.suggested.length + ' שמות דומים אך לא זהים — <b>מחכים לאישור שלך</b> במסך «בקרת בריפים».</div>';
        if ((r.unmatched || []).length) html += '<div class="msg warn">' + r.unmatched.length + ' שמות ללא התאמה — נשמרו לשיוך ידני.</div>';
        if ((r.duplicates || []).length) html += '<div class="msg warn">הופיעו פעמיים בהדבקה (האחרון נשמר): ' + esc(r.duplicates.join(', ')) + '</div>';
        if (r.skipped && r.skipped.length) html += '<div class="msg warn">שורות שדולגו (' + r.skipped.length + '): ' + esc(r.skipped.join(' · ')) + '</div>';
        msg.innerHTML = html;
        toast('עודכנו ' + r.updated + ' בריפים ✓');
        document.getElementById('bf-text').value = '';
        refresh();
        // אם יש מה לשייך ידנית — פותחים מיד את מסך הבקרה
        var needsWork = (r.suggested || []).length + (r.unmatched || []).length;
        if (needsWork) openBriefsControl();
      } catch (e) { msg.innerHTML = '<div class="msg error">' + esc(e.message) + '</div>'; }
    };
  }

  // ------------------------------------------------- מודאל: בקרת בריפים
  var BF_ONLY_MISSING = false;
  async function openBriefsControl() {
    var d;
    try { d = await call('/examiner/briefs-status'); } catch (e) { alert(e.message); return; }
    var m = document.getElementById('bf-modal');
    if (!m) { m = el('<div class="modal-back" id="bf-modal"></div>'); document.body.appendChild(m); }
    m.onclick = function (ev) { if (ev.target === m) m.remove(); };

    var opts = d.examinees.map(function (e) { return { code: e.code, name: e.name }; });
    // בריפים שממתינים לשיוך — עם ההצעה הטובה ביותר מסומנת מראש
    var pendHtml = (d.pending || []).length
      ? (d.pending || []).map(function (p) {
          var best = (p.suggestions || [])[0];
          var sel = '<option value="">— בחרו נבחן —</option>' + opts.map(function (o) {
            return '<option value="' + esc(o.code) + '"' + (best && best.code === o.code ? ' selected' : '') + '>' + esc(o.name) + '</option>';
          }).join('');
          var hint = best
            ? '<div class="bf-sugg">הצעה: <b>' + esc(best.name) + '</b> — ' + esc(best.reason) + ' <span class="bf-conf ' + best.confidence + '">' +
              (best.confidence === 'high' ? 'ביטחון גבוה' : (best.confidence === 'medium' ? 'ביטחון בינוני' : 'ביטחון נמוך')) + '</span></div>'
            : '<div class="bf-sugg none">לא נמצאה שום התאמה — בחרו ידנית.</div>';
          return '<div class="bf-pend">' +
            '<div><b>' + esc(p.raw_name) + '</b> <small style="color:var(--faint)">(כפי שהודבק)</small>' + hint +
            '<div class="bf-brief-txt">' + esc(p.brief) + '</div></div>' +
            '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
            '<select class="bf-pick" data-p="' + p.pending_id + '" style="min-width:170px">' + sel + '</select>' +
            '<button class="btn small bf-assign" data-p="' + p.pending_id + '">שייך</button>' +
            '<button class="btn ghost small bf-drop" data-p="' + p.pending_id + '">מחק</button>' +
            '</div></div>';
        }).join('')
      : '<p class="hint-text">אין בריפים שממתינים לשיוך.</p>';

    var rows = d.examinees.filter(function (e) { return !BF_ONLY_MISSING || !e.has_brief; }).map(function (e) {
      return '<tr' + (e.left ? ' style="opacity:.5"' : '') + '>' +
        '<td><b>' + esc(e.name) + '</b>' + (e.left ? ' <small style="color:var(--danger)">(עזב)</small>' : '') + '</td>' +
        '<td style="text-align:center">' + (e.has_brief ? '<span class="ok">✓</span>' : '<span style="color:var(--warn)">⚑</span>') + '</td>' +
        '<td><textarea class="bf-edit" data-c="' + esc(e.code) + '" style="min-height:44px;font-size:13px">' + esc(e.brief) + '</textarea></td>' +
        '<td><button class="btn ghost small bf-save" data-c="' + esc(e.code) + '">שמור</button>' +
        (e.has_brief ? ' <button class="btn ghost small bf-clear" data-c="' + esc(e.code) + '">נקה</button>' : '') + '</td></tr>';
    }).join('');

    m.innerHTML = '<div class="modal-card" style="max-width:920px">' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:4px"><h2 style="margin:0;font-size:20px">בקרת בריפים</h2>' +
      '<span style="flex:1"></span>' +
      '<button class="btn ghost small" id="bf-toggle">' + (BF_ONLY_MISSING ? 'הצג את כולם' : 'הצג רק מי שאין לו בריף') + '</button>' +
      '<button class="btn ghost small" id="bf-x">סגור</button></div>' +
      '<div class="save-sum">' +
      '<span><small>יש בריף</small><b class="ok">' + d.with_brief + '</b></span>' +
      '<span><small>אין בריף</small><b style="color:var(--warn)">' + d.without_brief + '</b></span>' +
      '<span><small>ממתינים לשיוך</small><b style="color:' + ((d.pending || []).length ? 'var(--warn)' : 'inherit') + '">' + (d.pending || []).length + '</b></span>' +
      '<span><small>שמות כפולים ביום</small><b style="color:' + ((d.duplicate_names || []).length ? 'var(--danger)' : 'inherit') + '">' + (d.duplicate_names || []).length + '</b></span>' +
      '</div>' +
      ((d.duplicate_names || []).length
        ? '<div class="msg warn" style="margin-top:10px">יש שני נבחנים באותו שם: ' + esc(d.duplicate_names.join(', ')) + ' — שיוך בריף לפי שם אינו חד-משמעי, בדקו ידנית.</div>' : '') +
      '<h3 style="font-size:15px;margin:16px 0 6px">בריפים שממתינים לשיוך</h3>' +
      '<p class="hint-text">אלה שמות שלא התאימו בדיוק (גרשיים, אות סופית, שם אמצעי, טעות הקלדה). <b>המערכת לא משייכת לבד</b> — בחרו ואשרו.</p>' +
      pendHtml +
      '<h3 style="font-size:15px;margin:18px 0 6px">כל הנבחנים</h3>' +
      '<div style="overflow-x:auto;max-height:340px;overflow-y:auto"><table class="grid"><thead><tr>' +
      '<th>שם</th><th>בריף?</th><th>הבריף</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div id="bfc-msg" style="margin-top:10px"></div></div>';

    document.getElementById('bf-x').onclick = function () { m.remove(); };
    document.getElementById('bf-toggle').onclick = function () { BF_ONLY_MISSING = !BF_ONLY_MISSING; openBriefsControl(); };
    m.querySelectorAll('.bf-assign').forEach(function (b) {
      b.onclick = async function () {
        var pid = b.getAttribute('data-p');
        var code = m.querySelector('.bf-pick[data-p="' + pid + '"]').value;
        if (!code) { document.getElementById('bfc-msg').innerHTML = '<div class="msg error">יש לבחור נבחן.</div>'; return; }
        try { var r = await call('/examiner/assign-pending-brief', 'POST', { pending_id: Number(pid), code: code });
          toast('הבריף שויך ל' + r.name + ' ✓'); openBriefsControl(); refresh();
        } catch (e) { document.getElementById('bfc-msg').innerHTML = '<div class="msg error">' + esc(e.message) + '</div>'; }
      };
    });
    m.querySelectorAll('.bf-drop').forEach(function (b) {
      b.onclick = async function () {
        if (!confirm('למחוק את הבריף הממתין?')) return;
        try { await call('/examiner/delete-pending-brief', 'POST', { pending_id: Number(b.getAttribute('data-p')) }); openBriefsControl(); }
        catch (e) { alert(e.message); }
      };
    });
    m.querySelectorAll('.bf-save').forEach(function (b) {
      b.onclick = async function () {
        var code = b.getAttribute('data-c');
        var txt = m.querySelector('.bf-edit[data-c="' + code + '"]').value;
        try { await call('/examiner/set-examinee-brief', 'POST', { code: code, brief: txt }); toast('נשמר ✓'); openBriefsControl(); refresh(); }
        catch (e) { alert(e.message); }
      };
    });
    m.querySelectorAll('.bf-clear').forEach(function (b) {
      b.onclick = async function () {
        try { await call('/examiner/clear-brief', 'POST', { code: b.getAttribute('data-c') }); toast('הבריף נמחק'); openBriefsControl(); refresh(); }
        catch (e) { alert(e.message); }
      };
    });
  }

  async function autosplit() {
    if (!confirm('לחלק אוטומטית לריאיון את מי שעדיין לא משובץ, שווה בשווה בין הסבבים הפתוחים?')) return;
    try { var r = await call('/examiner/autosplit-interviews', 'POST', {}); alert('שובצו ' + r.assigned + ' נבחנים לריאיון.'); refresh(); }
    catch (e) { alert(e.message); }
  }

  function renderPlanBoard(S) {
    var box = document.getElementById('planboard'); if (!box) return;
    var states = {}; S.rounds.forEach(function (r) { states[r.round] = r.state; });
    var byRound = {}; for (var i = 1; i <= S.total_rounds; i++) byRound[i] = [];
    S.examinees.forEach(function (e) { (e.marked_rounds || []).forEach(function (rn) { if (byRound[rn]) byRound[rn].push(e.name); }); });
    var html = '';
    for (var n = 1; n <= S.total_rounds; n++) {
      var st = states[n] || 'planned';
      var cls = st === 'running' ? 'running' : (st === 'ended' ? 'ended' : '');
      var lbl = st === 'running' ? 'פועל' : (st === 'ended' ? 'הסתיים' : 'מתוכנן');
      var names = byRound[n].length ? byRound[n].map(function (nm) { return '<span class="chip-name">' + esc(nm) + '</span>'; }).join('') : '<span style="color:var(--faint);font-size:12px">— ריק —</span>';
      html += '<div class="plan-col ' + cls + '"><div class="pc-head"><span>סבב ' + n + '</span><small>' + byRound[n].length + ' · ' + lbl + '</small></div>' + names + '</div>';
    }
    box.innerHTML = html;
  }

  // ------------------------------------------------- מטריצה מלאה
  var matrixHidden = false;
  function renderMatrix(M) {
    var box = document.getElementById('matrix'); if (!box) return;
    if (matrixHidden) { box.innerHTML = ''; return; }
    if (!M || !M.examinees.length) { box.innerHTML = '<p class="hint-text">אין נבחנים עדיין.</p>'; return; }
    var states = {}; M.rounds.forEach(function (r) { states[r.round] = r.state; });
    var head = '<th class="nm" style="min-width:130px">נבחן</th>';
    for (var n = 1; n <= M.total_rounds; n++) {
      var st = states[n] || 'planned';
      var rc = st === 'running' ? ' class="rc"' : '';
      var lbl = st === 'running' ? 'רץ עכשיו' : (st === 'ended' ? 'הסתיים' : 'מתוכנן');
      head += '<th' + rc + '>סבב ' + n + '<small>' + lbl + '</small></th>';
    }
    var rows = M.examinees.map(function (e) {
      var nm = '<td class="nm"><b>' + esc(e.name) + '</b>' +
        (e.needs_interview_unplanned ? ' <span style="color:var(--warn);font-size:11px" title="עדיין לא שובץ ריאיון">⚑ ריאיון?</span>' : '') +
        (e.left ? ' <small style="color:var(--danger)">(עזב)</small>' : '') +
        (!e.setup ? '<small>טרם בחר מקצועות</small>' : '') + '</td>';
      var tds = e.cells.map(function (c) {
        if (!c) return '<td class="mx idle">—</td>';
        // ⚠ inner היה מוקצה בלי var — בתוך 'use strict' זה ReferenceError שהפיל
        // את כל המטריצה, אבל רק מהרגע שלנבחן יש משבצת (כלומר כשהסבב מתחיל).
        var inner;
        if (c.type === 'done') inner = '<span class="ck">✓</span> ' + esc(c.label);
        else inner = esc(c.label) + (c.level ? ' <small style="opacity:.7">' + esc(c.level) + '</small>' : '');
        var clickable = c.type !== 'idle';
        return '<td class="mx ' + c.type + '"' + (clickable ? ' data-c="' + esc(e.code) + '"' : '') + '>' + inner + '</td>';
      }).join('');
      return '<tr class="' + (e.left ? 'mx-left' : '') + '">' + nm + tds + '</tr>';
    }).join('');
    box.innerHTML = '<table class="matrix"><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table>';
    box.querySelectorAll('td.mx[data-c]').forEach(function (td) {
      td.onclick = function () { openCard(td.getAttribute('data-c')); };
    });
  }

  // ------------------------------------------------- קונסולת הסבב
  // ------------------------------------------------- שעון הסבב
  // מקור הנתונים: `S.round_timer` מהשרת (אותו חישוב בדיוק שמגיע למסך המראיין
  // ולמסך הנבחן שהגיש). כאן רק מציגים ומחליקים בין רענון לרענון.
  var RT = null; // { timer, syncAt }

  function clockHM(ms) {
    if (!ms) return '--:--';
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  // כמה שניות נותרו *עכשיו*, בהחלקה מקומית מאז הסנכרון האחרון עם השרת.
  function rtNow() {
    if (!RT || !RT.timer || RT.timer.state === 'none') return null;
    var since = Math.floor((Date.now() - RT.syncAt) / 1000);
    if (RT.timer.state === 'paused') return { state: 'paused', remaining: RT.timer.remaining_sec, overtime: RT.timer.overtime_sec };
    var rem = RT.timer.remaining_sec - since;
    if (rem > 0) return { state: 'running', remaining: rem, overtime: 0 };
    return { state: 'expired', remaining: 0, overtime: RT.timer.overtime_sec + since };
  }

  function roundClockHtml(S, solvers) {
    if (!S.running || !S.round_timer || S.round_timer.state === 'none') return '';
    var t = S.round_timer;
    var done = solvers.filter(function (e) { return e.current && e.current.status === 'done'; }).length;
    var leftHtml = t.state === 'expired'
      ? '<b id="rt-left" class="over">+' + fmtTime(t.overtime_sec) + '</b>'
      : '<b id="rt-left">' + fmtTime(t.remaining_sec) + '</b>';
    return '<div class="round-clock' + (t.state === 'paused' ? ' paused' : '') + '">' +
      '<div class="iv-times">' +
      '<span><small>התחיל</small><b>' + clockHM(t.started_at) + '</b></span>' +
      '<span><small>אמור להסתיים</small><b>' + clockHM(t.ends_at) + '</b></span>' +
      '<span><small>' + (t.state === 'expired' ? 'חריגה' : 'נותר לסבב') + '</small>' + leftHtml + '</span>' +
      '<span><small>הגישו</small><b id="rt-done">' + done + ' / ' + solvers.length + '</b></span>' +
      '</div>' +
      (t.state === 'paused' ? '<p class="hint-text" style="text-align:center;margin:8px 0 0">⏸ הכול מושהה — השעון עצר.</p>' : '') +
      '</div>';
  }

  // רץ כל שנייה. ⚠ תמיד null-guard: הקופסה לא קיימת כשאין סבב פעיל.
  function roundTick() {
    var elm = document.getElementById('rt-left'); if (!elm) return;
    var v = rtNow(); if (!v) return;
    if (v.state === 'expired') { elm.textContent = '+' + fmtTime(v.overtime); elm.classList.add('over'); }
    else { elm.textContent = fmtTime(v.remaining); elm.classList.toggle('over', false); }
  }

  function renderConsole(S) {
    var box = document.getElementById('console'); if (!box) return;
    var states = {}; S.rounds.forEach(function (r) { states[r.round] = r.state; });
    var running = S.running;
    var firstPlanned = null; for (var i = 1; i <= S.total_rounds; i++) { if (states[i] === 'planned') { firstPlanned = i; break; } }
    var latestActive = 0; for (var k = S.total_rounds; k >= 1; k--) { if (states[k] && states[k] !== 'planned') { latestActive = k; break; } }
    var planningRound = running || firstPlanned;
    window.__planningRound = running ? null : firstPlanned; // איפה מותר לסמן

    var strip = S.rounds.map(function (r) {
      var cls = r.state === 'running' ? 'running' : (r.state === 'ended' ? 'ended' : '');
      var lbl = r.state === 'running' ? 'פועל' : (r.state === 'ended' ? 'הסתיים' : 'ממתין');
      return '<div class="round-chip ' + cls + '">סבב ' + r.round + '<small>' + lbl + '</small></div>';
    }).join('');

    // שתי רשימות
    var interviewers = [], solvers = [];
    S.examinees.forEach(function (e) {
      if (running) {
        if (e.current && e.current.kind === 'interview') interviewers.push(e);
        else if (e.current && e.current.kind === 'chapter') solvers.push(e);
      } else if (planningRound) {
        if (!e.interviewed && e.marked_rounds.indexOf(planningRound) >= 0) interviewers.push(e);
        else if (e.setup && !e.finished) solvers.push(e);
      }
    });
    function nameChips(arr, withNow) {
      if (!arr.length) return '<span style="color:var(--faint)">— אין —</span>';
      return arr.map(function (e) {
        var extra = '', cls = '';
        if (withNow && e.current && e.current.kind === 'chapter') {
          extra = ' · ' + esc(e.current.subject || '');
          // ⚠ מי שהגיש — הטיימר שלו עדיין "רץ" בחישוב, אבל להציג לו ספירה זה
          // מטעה (במיוחד ליד המונה «הגישו N/M»). מסמנים ✓ במקום.
          if (e.current.status === 'done') { extra += ' ✓ הגיש'; cls = ' done'; }
          else if (e.timer && e.timer.state === 'running') extra += ' (' + fmtTime(e.timer.remaining_sec) + ')';
        }
        return '<span class="chip-name' + cls + '">' + esc(e.name) + extra + '</span>';
      }).join('');
    }

    // כפתורי בקרה לפי מצב
    var controls = '';
    var title = '';
    if (running) {
      title = 'סבב ' + running + ' — פועל';
      controls = '<button class="btn" id="c-end">סיים סבב ' + running + '</button>' +
        '<button class="btn ghost" id="c-pause">⏸ השהה את כולם</button>' +
        '<button class="btn ghost" id="c-resume">▶ המשך לכולם</button>' +
        '<button class="btn ghost" id="c-resetall">אפס לכולם (טיימר מחדש)</button>' +
        '<button class="btn danger" id="c-reset" data-r="' + running + '">בטל/אפס סבב ' + running + '</button>';
    } else if (firstPlanned && (firstPlanned === 1 || states[firstPlanned - 1] === 'ended')) {
      title = 'סבב ' + firstPlanned + ' — מוכן. סמן/י בטבלה מי לריאיון, ואז לחצ/י התחל.';
      controls = '<button class="btn big" id="c-start" data-r="' + firstPlanned + '">התחל סבב ' + firstPlanned + '</button>';
      if (latestActive) controls += '<button class="btn danger ghost" id="c-reset" data-r="' + latestActive + '">בטל/אפס סבב ' + latestActive + '</button>';
    } else {
      title = 'כל הסבבים הסתיימו ✓';
      if (latestActive) controls = '<button class="btn danger ghost" id="c-reset" data-r="' + latestActive + '">בטל/אפס סבב ' + latestActive + '</button>';
    }

    box.innerHTML =
      '<h2 class="section-title">ניהול הסבב</h2>' +
      '<div class="round-strip">' + strip + '</div>' +
      roundClockHtml(S, solvers) +
      '<p style="font-weight:700;margin:14px 0 4px">' + esc(title) + '</p>' +
      '<div class="btn-row" id="console-controls">' + controls + '</div>' +
      '<div class="two-lists">' +
      '<div class="list-col"><div class="list-head interview">בריאיון (' + interviewers.length + ')</div>' + nameChips(interviewers, false) + '</div>' +
      '<div class="list-col"><div class="list-head chapter">בפרק (' + solvers.length + ')</div>' + nameChips(solvers, true) + '</div>' +
      '</div>';

    // כל handler קורא את הסבב מהכפתור עצמו (this) — לא ממשתנה משותף
    var s;
    if ((s = document.getElementById('c-start'))) s.onclick = function () { startRound(Number(this.getAttribute('data-r'))); };
    if ((s = document.getElementById('c-end'))) s.onclick = function () { endRound(); };
    if ((s = document.getElementById('c-reset'))) s.onclick = function () { resetRound(Number(this.getAttribute('data-r'))); };
    if ((s = document.getElementById('c-resetall'))) s.onclick = function () { resetAllCurrent(); };
    if ((s = document.getElementById('c-pause'))) s.onclick = function () { pauseAll(true); };
    if ((s = document.getElementById('c-resume'))) s.onclick = function () { pauseAll(false); };
  }

  // ------------------------------------------------- טבלת הנבחנים
  function attnOf(S, e) {
    if (e.left) return false;
    if (e.current && e.current.kind === 'chapter' && e.current.status !== 'done' && e.timer && e.timer.state === 'expired') return true;
    if (e.flags) return true;
    if (e.needs_interview && (e.marked_rounds || []).length === 0) return true;
    if (S.running && !e.setup) return true;
    return false;
  }

  function renderRoster(S) {
    var tb = document.getElementById('tbody'); if (!tb) return;
    // הגנה: אם פתוח כרגע בורר מראיין — לא לרנדר מחדש (שלא ייסגר באמצע הבחירה)
    if (tb.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
    var states = {}; S.rounds.forEach(function (r) { states[r.round] = r.state; });
    var hint = document.getElementById('roster-hint');
    if (hint) hint.innerHTML = S.running
      ? 'סבב <b>' + S.running + '</b> פועל. סבב שכבר התחיל/הסתיים נעול לסימון. לחצו "כרטיס" לטיפול פרטני בנבחן.'
      : 'קבעו לכל נבחן באיזה סבב הריאיון שלו (כפתורים 1–' + S.total_rounds + ') ואת המראיין/החדר. לחצו "כרטיס" לפרטים ולפעולות פרטניות.';

    var rows = S.examinees.slice().sort(function (a, b) { return (attnOf(S, b) ? 1 : 0) - (attnOf(S, a) ? 1 : 0); });

    tb.innerHTML = rows.map(function (e) {
      var ivCell;
      if (e.interviewed) ivCell = '<span style="color:var(--ok)">התראיין ✓</span>';
      else {
        var btns = '';
        for (var n = 1; n <= S.total_rounds; n++) {
          var on = e.marked_rounds.indexOf(n) >= 0;
          var locked = states[n] && states[n] !== 'planned';
          btns += '<button class="' + (on ? 'on' : '') + '" data-c="' + esc(e.code) + '" data-r="' + n + '"' + (locked ? ' disabled' : '') + '>' + n + '</button>';
        }
        ivCell = '<div class="rbtns" title="באיזה סבב הריאיון שלו">' + btns + '</div>';
      }

      var doneTxt = e.chapters_done.length ? e.chapters_done.join(', ') : '—';
      var remTxt = e.remaining_chapters.length ? e.remaining_chapters.join(', ') : '—';
      var ivTxt = e.interviewed ? '<span style="color:var(--ok)">התראיין ✓</span>' : '<span style="color:var(--warn)">טרם התראיין</span>';
      var status = '<div style="font-size:12px;line-height:1.7"><div>עשה: ' + esc(doneTxt) + '</div><div>נותר: ' + esc(remTxt) + '</div><div>' + ivTxt + (e.finished ? ' · <span style="color:var(--ok)">סיים הכול</span>' : '') + (e.left ? ' · <span style="color:var(--faint)">עזב</span>' : '') + '</div></div>';

      var now = '—';
      if (e.in_interview) now = '<span class="pill interview">בריאיון</span>';
      else if (e.current) {
        if (e.current.kind === 'interview') now = '<span class="pill interview">בריאיון</span>';
        else if (e.current.status === 'done') now = '<span class="pill done">הגיש</span>';
        else now = '<span class="pill chapter">' + esc(e.current.subject || '') + (e.current.level ? ' · ' + e.current.level : '') + '</span>' + (e.current.not_comfortable ? ' <span title="לא בנוח" style="color:var(--warn)">⚑</span>' : '');
      } else if (!e.setup) now = '<span style="color:var(--faint)">ממתין לרישום</span>';

      var timeCell = (!e.in_interview && e.current && e.current.kind === 'chapter' && e.current.status !== 'done')
        ? '<span class="t-' + (e.timer.state || 'none') + ' pill mono">' + fmtTime(e.timer.remaining_sec) + '</span>' : '<span style="color:var(--faint)">—</span>';
      var flags = e.flags ? '<span class="stat"><span class="dot-flag"></span>' + e.flags + '</span>' : '<span style="color:var(--faint)">0</span>';
      var cardBtn = '<button class="btn ghost small open-card" data-c="' + esc(e.code) + '">כרטיס</button>';
      var cls = (attnOf(S, e) ? 'attn' : '') + (e.left ? ' left-row' : '');

      // בורר מראיין (=חדר) לסבב הריאיון המשובץ
      var ivPick;
      if (e.interviewed) {
        var was = (e.interview_assign || []).filter(function (a) { return a.interviewer; })[0];
        ivPick = was ? '<span style="font-size:12px;color:var(--muted)">' + esc(was.interviewer) + (was.room ? ' · ' + esc(was.room) : '') + '</span>' : '<span style="color:var(--faint)">—</span>';
      } else if (!(e.marked_rounds || []).length) {
        ivPick = '<span style="color:var(--faint);font-size:12px">קבעו סבב קודם</span>';
      } else {
        var rnd = e.marked_rounds[0];
        var cur = (e.interview_assign || []).filter(function (a) { return a.round === rnd; })[0];
        var curId = cur && cur.interviewer_id ? cur.interviewer_id : '';
        var o = '<option value="">— בחרו מראיין —</option>' + (S.interviewers || []).map(function (v) {
          return '<option value="' + v.id + '"' + (String(v.id) === String(curId) ? ' selected' : '') + '>' + esc(v.name) + (v.room ? ' · ' + esc(v.room) : '') + '</option>';
        }).join('');
        ivPick = '<select class="iv-pick" data-c="' + esc(e.code) + '" data-r="' + rnd + '" style="min-width:150px;font-size:12px">' + o + '</select>' +
          (curId ? '' : ' <span style="color:var(--warn)" title="חסר מראיין">⚑</span>');
      }
      return '<tr class="' + cls.trim() + '"><td>' + esc(e.name) + (e.self_registered ? ' <span title="נרשם בשם שאינו ברשימה" style="color:var(--warn)">⚑</span>' : '') + '</td><td>' + ivCell + '</td><td>' + ivPick + '</td><td>' + status + '</td><td>' + now + '</td><td>' + timeCell + '</td><td>' + flags + '</td><td>' + cardBtn + '</td></tr>';
    }).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--faint);padding:30px">אין נבחנים עדיין. הוסיפו בחלק "ניהול נבחנים".</td></tr>';

    var iv = S.examinees.filter(function (e) { return e.interviewed; }).length;
    var need = S.examinees.filter(function (e) { return e.needs_interview; }).length;
    document.getElementById('summary').innerHTML = S.examinees.length + ' נבחנים · התראיינו: ' + iv + ' · ממתינים לריאיון: ' + need;

    tb.querySelectorAll('.rbtns button').forEach(function (b) {
      if (b.disabled) return;
      b.onclick = function () {
        var on = !b.classList.contains('on');
        call('/examiner/mark-interview', 'POST', { code: b.getAttribute('data-c'), round: Number(b.getAttribute('data-r')), on: on })
          .then(function (r) { if (r && r.warn) alert(r.warn); refresh(); }).catch(function (e) { alert(e.message); refresh(); });
      };
    });
    tb.querySelectorAll('.iv-pick').forEach(function (sel) {
      sel.onchange = function () {
        call('/examiner/assign-interviewer', 'POST', {
          code: sel.getAttribute('data-c'), round: Number(sel.getAttribute('data-r')),
          interviewer_id: sel.value ? Number(sel.value) : null,
        }).then(function () { refresh(); loadInterviewers(); }).catch(function (e) { alert(e.message); refresh(); });
      };
    });
    tb.querySelectorAll('.open-card').forEach(function (b) { b.onclick = function () { openCard(b.getAttribute('data-c')); }; });
  }

  // ------------------------------------------------- כרטיס נבחן (מודאל)
  function openCard(code) { window.__openCardCode = code; renderCard(code); }
  function closeCard() { window.__openCardCode = null; var m = document.getElementById('card-modal'); if (m) m.remove(); }
  function renderCard(code) {
    var e = STATE && STATE.examinees.find(function (x) { return x.code === code; });
    if (!e) { closeCard(); return; }
    // הגנה: אם מקלידים כרגע בתוך הכרטיס (בריף/עריכת שם) — לא לרנדר מחדש
    var openM = document.getElementById('card-modal');
    if (openM && openM.contains(document.activeElement) &&
        /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    var m = document.getElementById('card-modal');
    if (!m) { m = el('<div class="modal-back" id="card-modal"></div>'); document.body.appendChild(m); m.onclick = function (ev) { if (ev.target === m) closeCard(); }; }
    var tl = '';
    e.chapters_done.forEach(function (s) { tl += '<span class="tl done">✓ ' + esc(s) + '</span>'; });
    if (e.interviewed) tl += '<span class="tl done">✓ ריאיון</span>';
    if (e.in_interview) tl += '<span class="tl now">▶ בריאיון</span>';
    else if (e.current) { var lab = e.current.kind === 'interview' ? 'ריאיון' : esc(e.current.subject || ''); tl += '<span class="tl now">▶ ' + lab + (e.timer && e.timer.state === 'running' ? ' ' + fmtTime(e.timer.remaining_sec) : '') + '</span>'; }
    e.remaining_chapters.forEach(function (s) { tl += '<span class="tl pending">' + esc(s) + '</span>'; });
    if (!e.interviewed && !e.in_interview && !(e.current && e.current.kind === 'interview')) tl += '<span class="tl pending">ריאיון</span>';

    var actions =
      '<button class="btn" data-x="advance">קדם לפעילות הבאה</button>' +
      (e.in_interview ? '<button class="btn" data-x="ireturn">חזר מריאיון</button>' : '<button class="btn ghost" data-x="iout">שלח לריאיון עכשיו</button>') +
      '<button class="btn ghost" data-x="add_time">הוסף 2 דקות</button>' +
      '<button class="btn ghost" data-x="reset_slot">אפס משבצת</button>' +
      '<button class="btn ghost" data-x="reopen" title="נבחן שהגיש פרק בטעות — מחזיר אותו לפרק להמשך עבודה. הזמן שנשאר נשמר.">פתח הגשה מחדש</button>' +
      (e.left ? '<button class="btn ghost" data-x="unleft">החזר לפעילות</button>' : '<button class="btn ghost" data-x="left">סמן: עזב</button>') +
      '<button class="btn danger" data-x="remove">הסר נבחן</button>';

    // תיקון הפרק הנוכחי בלייב — הזמן שנשאר נשמר
    var fixHtml = '';
    if (e.current && e.current.kind === 'chapter' && e.current.status !== 'done') {
      var subjOpts = '<option value="">— החלף מקצוע ל… —</option>' + availableSubjects.map(function (sb) {
        return '<option value="' + esc(sb) + '"' + (sb === e.current.subject ? ' disabled' : '') + '>' + esc(sb) + '</option>';
      }).join('');
      fixHtml =
        '<div style="font-size:13px;color:var(--muted);margin-top:14px">תיקון הפרק הנוכחי (' + esc(e.current.subject || '') +
        (e.current.level ? ' · ' + esc(e.current.level) + ' יח״ל' : '') + ') — <b style="color:var(--ok)">הזמן שנשאר נשמר</b></div>' +
        '<div class="mc-actions">' +
        (e.current.subject === 'מתמטיקה' ? '<button class="btn ghost" data-fx="lower_level">הורד רמה (5→4→3)</button>' : '') +
        '<button class="btn ghost" data-fx="swap_variant">החלף שאלה (נושא אחר באותו מקצוע)</button>' +
        '<select id="fx-subject" style="min-width:190px">' + subjOpts + '</select>' +
        '</div><div id="fx-msg"></div>';
    }
    // בריף קצר על הנבחן — מה שהמראיין שלו יראה
    var briefHtml =
      '<div style="font-size:13px;color:var(--muted);margin-top:14px">בריף למראיין (מה שהמראיין/ת של הנבחן יראה)</div>' +
      '<div style="display:flex;gap:8px;align-items:flex-end">' +
      '<label class="field" style="margin:0;flex:1"><textarea id="card-brief" style="min-height:56px" placeholder="למשל: מועמדת חזקה במתמטיקה, כדאי לבדוק ניסיון בהוראה.">' + esc(e.interview_brief || '') + '</textarea></label>' +
      '<button class="btn small" data-x="save_brief">שמור בריף</button></div>';

    var ivText = (e.marked_rounds && e.marked_rounds.length) ? ('סבב ' + e.marked_rounds.join(', ')) : (e.interviewed ? 'התראיין ✓' : 'טרם נקבע');
    var editing = window.__cardEditing === code;
    var meta = editing
      ? '<div class="mc-edit" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px;background:rgba(255,255,255,.03);padding:10px;border-radius:10px">' +
          '<label class="field" style="margin:0;flex:1;min-width:150px"><span>שם</span><input id="edit-name" type="text" value="' + esc(e.name) + '"></label>' +
          '<label class="field" style="margin:0;flex:1;min-width:120px"><span>קוד אישי</span><input id="edit-pin" type="text" value="' + esc(e.pin || '') + '" placeholder="ריק = לפי שם בלבד"></label>' +
          '<button class="btn small" data-x="save_edit">שמור</button>' +
          '<button class="btn ghost small" data-x="cancel_edit">בטל</button>' +
        '</div>'
      : '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;background:rgba(35,179,164,.08);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:14px">' +
          '<div>קוד אישי <span style="color:var(--faint);font-size:12px">(סיסמה)</span>: <b style="font-size:16px;font-family:var(--mono)">' + esc(e.pin || '—') + '</b></div>' +
          '<div>סבב ריאיון: <b>' + esc(ivText) + '</b></div>' +
          '<div style="color:var(--muted)">מקצועות: ' + esc((e.subjects || []).join(', ') || 'טרם בחר') + '</div>' +
          '<span style="flex:1"></span>' +
          '<button class="btn ghost small" data-x="edit">ערוך שם/קוד</button></div>';

    // שאלון ההצהרה (דיווח עצמי) — מוצג לבוחן אם מולא
    var declHtml = '';
    var d = e.declaration;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      var dsubs = Array.isArray(d.subjects) ? d.subjects : [];
      var parts = [];
      if (dsubs.length) parts.push('מקצועות שהוצהרו: ' + esc(dsubs.join(', ')) + (d.mathLevel ? ' · מתמטיקה ' + esc(d.mathLevel) + ' יח״ל' : ''));
      if (d.note) parts.push('הערה: ' + esc(d.note));
      if (parts.length) declHtml = '<div style="font-size:13px;color:var(--muted);margin-top:10px;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:8px;padding:9px 13px"><b style="color:var(--faint)">שאלון הצהרה</b> — ' + parts.join(' · ') + '</div>';
    }

    m.innerHTML = '<div class="modal-card">' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:6px"><h2 style="margin:0;font-size:20px">' + esc(e.name) + '</h2><span style="flex:1"></span><button class="btn ghost small" id="card-close">סגור</button></div>' +
      meta + declHtml +
      '<div style="font-size:13px;color:var(--muted);margin-top:12px">מסלול</div><div class="timeline">' + (tl || '<span style="color:var(--faint)">—</span>') + '</div>' +
      '<div style="font-size:13px;color:var(--muted);margin-top:12px">טיפול פרטני (לא משפיע על שאר הכיתה)</div>' +
      '<p class="hint-text" style="margin:2px 0 6px"><b>פתח הגשה מחדש</b> = נבחן שהגיש פרק בטעות חוזר לפרק ויכול להמשיך לענות (הזמן שנשאר נשמר).</p>' +
      '<div class="mc-actions">' + actions + '</div>' + fixHtml + briefHtml + '</div>';
    document.getElementById('card-close').onclick = closeCard;
    m.querySelectorAll('.mc-actions button, .mc-edit button, [data-x="edit"], [data-x="save_brief"]').forEach(function (b) { b.onclick = function () { cardAction(code, b.getAttribute('data-x')); }; });
    m.querySelectorAll('[data-fx]').forEach(function (b) { b.onclick = function () { fixSlot(code, b.getAttribute('data-fx')); }; });
    var fxs = document.getElementById('fx-subject');
    if (fxs) fxs.onchange = function () { if (fxs.value) fixSlot(code, 'change_subject', fxs.value); };
  }
  async function fixSlot(code, action, subject) {
    var box = document.getElementById('fx-msg');
    try {
      var r = await call('/examiner/fix-slot', 'POST', { code: code, action: action, subject: subject });
      if (box) box.innerHTML = '<div class="msg info">הפרק הוחלף ל: ' + esc(r.subject) + (r.level ? ' · ' + esc(r.level) + ' יח״ל' : '') + '. הזמן שנשאר נשמר.</div>';
      refresh();
    } catch (e) {
      if (box) box.innerHTML = '<div class="msg error">' + esc(e.message) + '</div>'; else alert(e.message);
    }
  }
  async function cardAction(code, x) {
    try {
      if (x === 'save_brief') {
        var bt = document.getElementById('card-brief');
        await call('/examiner/set-examinee-brief', 'POST', { code: code, brief: bt ? bt.value : '' });
        refresh(); return;
      }
      if (x === 'edit') { window.__cardEditing = code; renderCard(code); return; }
      else if (x === 'cancel_edit') { window.__cardEditing = null; renderCard(code); return; }
      else if (x === 'save_edit') {
        var newName = document.getElementById('edit-name').value.trim();
        var newPin = document.getElementById('edit-pin').value.trim();
        await call('/examiner/edit-examinee', 'POST', { code: code, name: newName, pin: newPin });
        window.__cardEditing = null; refresh(); return;
      }
      else if (x === 'advance') { var r = await call('/examiner/advance-examinee', 'POST', { code: code }); if (r.warn) alert(r.warn); }
      else if (x === 'iout') await call('/examiner/interview-out', 'POST', { code: code });
      else if (x === 'ireturn') await call('/examiner/interview-return', 'POST', { code: code });
      else if (x === 'reopen') await call('/examiner/reopen-submit', 'POST', { code: code });
      else if (x === 'left') await call('/examiner/set-left', 'POST', { code: code, left: true });
      else if (x === 'unleft') await call('/examiner/set-left', 'POST', { code: code, left: false });
      else if (x === 'remove') { if (!confirm('להסיר את הנבחן? כל הנתונים שלו יימחקו.')) return; await call('/examiner/remove-examinee', 'POST', { code: code }); closeCard(); }
      else if (x === 'add_time') await call('/examiner/override', 'POST', { code: code, action: 'add_time', seconds: 120 });
      else if (x === 'reset_slot') await call('/examiner/override', 'POST', { code: code, action: 'reset_slot' });
      refresh();
    } catch (e) { alert(e.message); }
  }

  // ------------------------------------------------- פעולות סבב
  async function startRound(r) {
    // אזהרה מונעת: מי שטרם בחר מקצועות לא יקבל פרק בסבב הזה
    // (הוא יצטרף אוטומטית ברגע שיבחר — תיקון עצמי בשרת).
    var S = STATE || {};
    var noSubj = (S.examinees || []).filter(function (e) {
      return !e.left && !e.setup && !(e.marked_rounds || []).length;
    });
    if (noSubj.length) {
      var names = noSubj.slice(0, 6).map(function (e) { return e.name; }).join(', ') + (noSubj.length > 6 ? ' ועוד…' : '');
      if (!confirm(noSubj.length + ' נבחנים עדיין לא בחרו מקצועות:\n' + names +
        '\n\nהם לא יקבלו פרק בסבב ' + r + ' — אבל יצטרפו אוטומטית ברגע שיבחרו.\n\nלהתחיל את הסבב בכל זאת?')) return;
    }
    try {
      var res = await call('/examiner/start-round', 'POST', { round: r });
      var extra = (res.no_subjects || []).length ? ' · ' + res.no_subjects.length + ' טרם בחרו מקצועות (יצטרפו כשיבחרו)' : '';
      toast('סבב ' + r + ' התחיל · ' + res.interviews + ' בריאיון · ' + res.chapters + ' בפרק' + extra);
      refresh();
    } catch (e) { alert(e.message); }
  }
  async function endRound() {
    // ⚠ המנוע תמיד הרשה לסיים סבב באמצע — אבל בשקט. כאן מראים למנהל את מי
    // בדיוק הוא חותך, כדי שההחלטה (לחכות עוד דקה / לסיים) תהיה מדעת.
    var late = (STATE && STATE.examinees || []).filter(function (e) {
      return e.current && e.current.kind === 'chapter' && e.current.status !== 'done';
    });
    var msg;
    if (late.length) {
      var names = late.slice(0, 6).map(function (e) {
        return '• ' + e.name + ' (' + (e.current.subject || 'פרק') + ', ' + (e.answered || 0) + ' תשובות)';
      }).join('\n');
      if (late.length > 6) names += '\n• ועוד ' + (late.length - 6) + '…';
      msg = '⚠ ' + (late.length === 1 ? 'נבחן אחד עדיין לא הגיש' : late.length + ' נבחנים עדיין לא הגישו') + ':\n\n' + names +
        '\n\nלסיים את הסבב בכל זאת? הפרק שלהם ייסגר עם מה שכתבו עד עכשיו (התשובות נשמרות ונכנסות לבדיקה), והם יעברו להמתנה לסבב הבא.';
    } else {
      msg = 'כולם הגישו ✓  לסיים את הסבב הנוכחי? הנבחנים יעברו להמתנה לסבב הבא.';
    }
    if (!confirm(msg)) return;
    try {
      var res = await call('/examiner/end-round', 'POST', {});
      toast(res.unsubmitted_count
        ? 'סבב ' + res.round + ' הסתיים · ' + (res.unsubmitted_count === 1 ? 'אחד נסגר' : res.unsubmitted_count + ' נסגרו') +
          ' באמצע: ' + res.unsubmitted.map(function (u) { return u.name; }).join(', ')
        : 'סבב ' + res.round + ' הסתיים · כולם הגישו ✓');
      refresh();
    } catch (e) { alert(e.message); }
  }
  async function resetRound(r) {
    if (!confirm('לבטל/לאפס את סבב ' + r + '? המשבצות של הסבב יימחקו והוא יחזור למצב "מוכן". התשובות נשמרות. (נוצר גיבוי לפני.)')) return;
    try { await call('/examiner/reset-round', 'POST', { round: r }); refresh(); } catch (e) { alert(e.message); }
  }
  async function resetAllCurrent() {
    if (!confirm('לאפס את הטיימר והמשבצת של כל הנבחנים בסבב הנוכחי?')) return;
    try { await call('/examiner/reset-all-current', 'POST', {}); refresh(); } catch (e) { alert(e.message); }
  }
  async function pauseAll(pause) {
    try { var r = await call('/examiner/pause-all', 'POST', { pause: pause }); if (pause) alert('הושהו ' + r.affected + ' נבחנים.'); refresh(); }
    catch (e) { alert(e.message); }
  }
  async function endExam() {
    if (!confirm('לסיים את המבחן לכל הנבחנים? כולם יעברו למסך "המבחן הסתיים".')) return;
    try { await call('/examiner/end-exam', 'POST', { ended: true }); refresh(); } catch (e) { alert(e.message); }
  }
  async function fullReset() {
    if (!confirm('אפס יום מלא: למחוק את כל ההתקדמות והתשובות ולהתחיל מאפס? הנבחנים והתכנון יישמרו. (נוצר גיבוי לפני.)')) return;
    if (!confirm('בטוח? פעולה זו מוחקת את כל התשובות שנשמרו.')) return;
    try { await call('/examiner/full-reset', 'POST', {}); refresh(); } catch (e) { alert(e.message); }
  }
  async function removeAllExaminees() {
    if (!confirm('להסיר את כל הנבחנים? כל הנבחנים, התשובות וההתקדמות יימחקו לצמיתות (תכנון הסבבים יישמר). נוצר גיבוי לפני.')) return;
    if (!confirm('בטוח לגמרי? אי אפשר לבטל את הפעולה.')) return;
    try { await call('/examiner/remove-all-examinees', 'POST', {}); refresh(); } catch (e) { alert(e.message); }
  }

  async function renderExamState() {
    var box = document.getElementById('ended-banner'); if (!box) return;
    try {
      var s = await call('/examiner/exam-state');
      if (s.ended) {
        box.innerHTML = '';
        box.appendChild(el('<div class="msg warn" style="display:flex;align-items:center;gap:12px"><span>המבחן במצב "הסתיים" — כל הנבחנים רואים מסך סיום.</span><button class="btn ghost small" id="btn-reopen">החזר לפעילות</button></div>'));
        document.getElementById('btn-reopen').onclick = function () { call('/examiner/end-exam', 'POST', { ended: false }).then(renderExamState).catch(function (e) { alert(e.message); }); };
      } else box.innerHTML = '';
    } catch (e) {}
  }

  // ------------------------------------------------- ניהול נבחנים
  function renderAddSubjects() {
    var box = document.getElementById('add-subjects'); if (!box) return;
    box.innerHTML = availableSubjects.map(function (s) {
      var i = addSubjects.indexOf(s), sel = i >= 0;
      return '<div class="chip ' + (sel ? 'selected' : '') + '" data-s="' + esc(s) + '">' + esc(s) + (sel ? ' <span class="order">#' + (i + 1) + '</span>' : '') + '</div>';
    }).join('');
    box.querySelectorAll('.chip').forEach(function (c) {
      c.onclick = function () {
        var s = c.getAttribute('data-s'), i = addSubjects.indexOf(s);
        if (i >= 0) addSubjects.splice(i, 1); else { if (addSubjects.length >= 4) return; addSubjects.push(s); }
        renderAddSubjects();
      };
    });
  }
  async function addOne() {
    var name = document.getElementById('add-name').value.trim(), code = document.getElementById('add-code').value.trim();
    var iround = document.getElementById('add-iround').value, box = document.getElementById('add-msg');
    if (!name) { box.innerHTML = '<div class="msg error">יש למלא שם.</div>'; return; }
    try {
      await call('/examiner/add-examinee', 'POST', { name: name, code: code, subjects: addSubjects.slice(), interview_round: iround || undefined });
      box.innerHTML = '<div class="msg info">נוסף: ' + esc(name) + '.</div>';
      document.getElementById('add-name').value = ''; document.getElementById('add-code').value = ''; document.getElementById('add-iround').value = '';
      addSubjects = []; renderAddSubjects(); refresh();
    } catch (e) { box.innerHTML = '<div class="msg error">' + esc(e.message) + '</div>'; }
  }
  async function addBulk() {
    var text = document.getElementById('bulk-text').value, box = document.getElementById('add-msg');
    if (!text.trim()) { box.innerHTML = '<div class="msg error">הרשימה ריקה.</div>'; return; }
    try {
      var r = await call('/examiner/add-examinees-bulk', 'POST', { text: text });
      var msg = 'נוספו ' + r.added + '.'; if (r.skipped && r.skipped.length) msg += ' דילג על ' + r.skipped.length + '.';
      box.innerHTML = '<div class="msg ' + (r.added ? 'info' : 'warn') + '">' + esc(msg) + '</div>';
      document.getElementById('bulk-text').value = ''; refresh();
    } catch (e) { box.innerHTML = '<div class="msg error">' + esc(e.message) + '</div>'; }
  }
  async function loadPlan() {
    var text = document.getElementById('plan-text').value, box = document.getElementById('add-msg');
    if (!text.trim()) { box.innerHTML = '<div class="msg error">התכנון ריק.</div>'; return; }
    try {
      var r = await call('/examiner/set-interview-plan', 'POST', { text: text });
      var msg = 'סומנו ' + r.marked + ' לריאיון.'; if (r.skipped && r.skipped.length) msg += ' דילג על ' + r.skipped.length + '.';
      box.innerHTML = '<div class="msg ' + (r.marked ? 'info' : 'warn') + '">' + esc(msg) + '</div>';
      document.getElementById('plan-text').value = ''; refresh();
    } catch (e) { box.innerHTML = '<div class="msg error">' + esc(e.message) + '</div>'; }
  }

  // ------------------------------------------------- גיבוי / ייצוא / תקינות
  function fmtBytes(n) { return n < 1024 ? n + ' ב׳' : (n / 1024).toFixed(1) + ' KB'; }
  function fmtWhen(ms) { try { return new Date(ms).toLocaleString('he-IL'); } catch (e) { return ''; } }
  async function loadBackups() {
    var box = document.getElementById('backup-list'); if (!box) return;
    try {
      var r = await call('/examiner/backups');
      if (!r.files.length) { box.innerHTML = 'עדיין אין גיבויים.'; return; }
      box.innerHTML = '<div style="margin-bottom:6px;color:var(--muted)">גיבוי אחרון: ' + fmtWhen(r.files[0].at) + '</div>' +
        r.files.slice(0, 10).map(function (f) {
          var kind = f.name.indexOf('snapshot') === 0 ? 'עותק DB' : 'JSON';
          return '<div style="display:flex;align-items:center;gap:10px;padding:3px 0"><button class="dl-bk" data-bk="' + esc(f.name) + '" style="border:1px solid var(--border);background:rgba(8,14,36,.5);color:var(--muted);border-radius:8px;padding:3px 10px;cursor:pointer">הורד</button><span style="color:var(--faint)">' + kind + ' · ' + fmtBytes(f.size) + ' · ' + fmtWhen(f.at) + '</span></div>';
        }).join('');
      box.querySelectorAll('.dl-bk').forEach(function (b) { b.onclick = function () { downloadBackup(b.getAttribute('data-bk')); }; });
    } catch (e) { box.innerHTML = '<span class="bad">שגיאה בטעינת הגיבויים.</span>'; }
  }
  async function backupNow() { try { var r = await call('/examiner/backup-now', 'POST'); if (!r.ok) throw new Error(r.error || 'נכשל'); loadBackups(); } catch (e) { alert(e.message); } }
  async function downloadBlob(path, filename) {
    var res = await call(path, 'GET', null, true); if (!res.ok) throw new Error('הורדה נכשלה');
    var blob = await res.blob(), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  function downloadBackup(name) { downloadBlob('/examiner/backup/' + encodeURIComponent(name), name).catch(function (e) { alert(e.message); }); }
  function downloadRoster() { downloadBlob('/examiner/export-roster', 'examinees-roster.xlsx').catch(function (e) { alert(e.message); }); }
  function downloadExcel() { downloadBlob('/examiner/export-excel', 'assessment-answers.xlsx').catch(function (e) { alert(e.message); }); }
  function downloadExport() { downloadBlob('/examiner/export-all', 'assessment-answers.json').catch(function (e) { alert(e.message); }); }

  var healthShown = false;
  async function toggleHealth() {
    var box = document.getElementById('health');
    if (healthShown) { box.innerHTML = ''; healthShown = false; return; }
    healthShown = true;
    try {
      var h = await call('/examiner/content-health');
      var rows = h.chapters.map(function (c) { return '<div>' + (c.valid ? '<span class="ok">✓</span> ' : '<span class="bad">✗</span> ') + esc(c.chapter_id) + ' <span style="color:var(--faint)">(' + esc(c.subject) + ')</span></div>'; }).join('');
      var probs = (h.problems || []).filter(function (p) { return p.level === 'error'; });
      box.innerHTML = '<div style="margin-top:14px"><b>תקינות בנק התוכן</b><div class="health-list">' + rows + '</div>' +
        (probs.length ? '<div class="msg error" style="margin-top:10px">' + probs.length + ' בעיות. הרץ: npm run check-content</div>' : '<div class="msg info" style="margin-top:10px">כל הפרקים תקינים.</div>') + '</div>';
    } catch (e) { box.innerHTML = '<div class="msg error">' + esc(e.message) + '</div>'; }
  }

  // ------------------------------------------------- לולאה
  async function refresh() {
    try { STATE = await call('/examiner/status'); } catch (e) { if (e.status === 401) return renderLogin('פג תוקף. התחבר/י מחדש.'); return; }
    // סנכרון שעון הסבב — הרענון כל 3 שניות; ה-tick מחליק בין לבין.
    RT = { timer: STATE.round_timer || null, syncAt: Date.now() };
    var M = null;
    if (!matrixHidden) { try { M = await call('/examiner/matrix'); } catch (e) { /* אל תשבור את הרענון */ } }
    // ⚠ כל חלק מצטייר בנפרד: כשל באחד לא מפיל את השאר (זה מה שהסתיר באג
    // שבו טבלת הנבחנים לא הוצגה בכלל). שגיאה מדווחת ולא נבלעת בשקט.
    var broke = [];
    function part(name, fn) {
      try { fn(); } catch (e) { broke.push(name); console.error('שגיאת רינדור ב-' + name + ':', e); }
    }
    part('שער היום', function () { renderDaySetup(); });
    part('פס מוכנות', function () { renderReadiness(STATE); });
    part('בקשות החלפה', function () { renderSwaps(STATE); });
    part('קונסולת סבב', function () { renderConsole(STATE); });
    part('לוח תכנון', function () { renderPlanBoard(STATE); });
    part('מטריצה', function () { renderMatrix(M); });
    part('טבלת נבחנים', function () { renderRoster(STATE); });
    part('מצב מבחן', function () { renderExamState(); });
    if (window.__openCardCode) part('כרטיס נבחן', function () { renderCard(window.__openCardCode); });
    var errBox = document.getElementById('render-err');
    if (errBox) {
      errBox.innerHTML = broke.length
        ? '<div class="msg error">תקלת תצוגה ב: ' + esc(broke.join(', ')) +
          '. הנתונים שמורים — נסו לרענן (Cmd+Shift+R). אם זה חוזר, צרו צילום מסך.</div>'
        : '';
    }
  }
  async function start() {
    try { availableSubjects = (await call('/subjects')).subjects || []; } catch (e) { availableSubjects = []; }
    renderShell();
    await loadDays();
    loadInterviewers();
    renderBriefs();
    renderDaySaves();
    refresh(); loadBackups();
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(refresh, 3000);
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = setInterval(roundTick, 1000);
  }

  async function enter() {
    if (token) { try { await call('/examiner/status'); start(); return; } catch (e) { token = null; localStorage.removeItem('yh_examiner_token'); } }
    renderLogin();
  }
  function leave() {
    if (pollHandle) clearInterval(pollHandle);
    if (tickHandle) clearInterval(tickHandle);
    if (typeof window.__showExamineeLogin === 'function') window.__showExamineeLogin();
    else location.href = '/';
  }
  return { enter: enter, leave: leave };
})();
