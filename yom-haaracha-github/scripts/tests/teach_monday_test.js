// בדיקת זרימת מאנדיי של בוחן ההוראה — בלי טוקן, עם סטאב של lib/monday.
process.env.DB_PATH = process.env.DB_PATH || require('os').tmpdir() + '/teach_monday_test.db';
try { require('fs').unlinkSync(process.env.DB_PATH); } catch (e) {}
const APP = require('path').join(__dirname, '..', '..') + '/';
const express = require(APP + 'node_modules/express');
const { db } = require(APP + 'db.js');
const monday = require(APP + 'lib/monday.js');
const calls = [];
const BOARD_COLS = { id: '18414628784', name: 'שאלון מועמדות למורים - 2026/27', columns: [
  { id: 'name', title: 'Name', type: 'name' }, { id: 'phone1', title: 'טלפון', type: 'phone' },
  { id: 'text_mm6k8ekh', title: 'ציון מבחן', type: 'text' }, { id: 'text_mm6k2vst', title: 'הערכה מילולית', type: 'text' },
  { id: 'long_textp3hadwsv', title: 'Long text', type: 'long_text' } ] };
const ITEMS = [ { id: '1001', name: 'יואלה פיטרמן' }, { id: '1002', name: 'הודיה חריר' }, { id: '1003', name: 'עמית כהן' }, { id: '1004', name: 'עמית נהרי' } ];
monday.hasToken = () => true;
monday.boardColumns = async (id) => { calls.push(['cols', id]); return BOARD_COLS; };
monday.boardItems = async (id) => { calls.push(['items', id]); return ITEMS; };
monday.setValues = async (b, item, vals) => { calls.push(['set', b, item, vals]); return true; };
monday.createItem = async (b, name, vals) => { calls.push(['create', b, name, vals]); return '2001'; };

const app = express(); app.use(express.json());
require(APP + 'lib/teachRoutes.js').register(app, { db, now: () => Date.now(), newToken: () => require('crypto').randomBytes(24).toString('hex'), authExaminer: (q, s, n) => n() });
const srv = app.listen(0, async () => {
  const port = srv.address().port; const B = 'http://localhost:' + port;
  const api = async (p, body, tok) => { const r = await fetch(B + p, { method: body ? 'POST' : 'GET', headers: Object.assign({ 'content-type': 'application/json' }, tok ? { 'x-token': tok } : {}), body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json() }; };
  const mk = async (name) => {
    const { j } = await api('/api/teach/login', { name, pin: '1234', phone: '0501234567' });
    await api('/api/teach/start', { subject_id: 'math5' }, j.token);
    await api('/api/teach/answer', { qid: 'q2', value: 'תשובה' }, j.token);
    await api('/api/teach/submit', {}, j.token);
    const list = (await api('/api/examiner/teach/list')).j.candidates; return list.find(c => c.name === name).code;
  };
  const ok = (cond, msg) => console.log((cond ? 'PASS' : 'FAIL') + ' · ' + msg);
  // 1) התאמה מדויקת לבורד הקבוע, בלי board_id ובלי mapping
  const c1 = await mk('יואלה פיטרמן');
  await api('/api/examiner/teach/grade', { code: c1, qid: 'q2', checks: { a: true }, comment: 'מנוסחת היטב' });
  let r = await api('/api/examiner/teach/monday/send', { code: c1 });
  ok(r.status === 200 && r.j.item_id === '1001' && r.j.item_name === 'יואלה פיטרמן' && !r.j.created, 'exact name → updated row 1001: ' + JSON.stringify(r.j).slice(0, 160));
  const set = calls.find(c => c[0] === 'set');
  ok(set && Object.keys(set[3]).length === 2 && /\/ 24 \(/.test(set[3].text_mm6k8ekh) && /מתמטיקה/.test(set[3].text_mm6k2vst), 'wrote 2 columns: ' + JSON.stringify(set && set[3]));
  const setup = (await api('/api/examiner/teach/monday/setup')).j;
  ok(setup.board_id === '18414628784' && setup.mapping && setup.mapping.total === 'text_mm6k8ekh', 'setup remembers board + mapping: ' + JSON.stringify(setup.mapping));
  // 2) שליחה חוזרת — בלי חיפוש שמות
  calls.length = 0; r = await api('/api/examiner/teach/monday/send', { code: c1 });
  ok(r.status === 200 && !calls.some(c => c[0] === 'items'), 'resend uses stored item, no items fetch');
  // 3) שם דומה אבל לא זהה → 409 עם הצעות
  const c2 = await mk('עמית');
  r = await api('/api/examiner/teach/monday/send', { code: c2 });
  ok(r.status === 409 && r.j.needs_pick && r.j.suggestions.length >= 2, '409 needs_pick, suggestions: ' + r.j.suggestions.map(s => s.name + ' (' + s.reason + ')').join(', '));
  // 4) בחירה ידנית
  r = await api('/api/examiner/teach/monday/send', { code: c2, item_id: '1004', item_name: 'עמית נהרי' });
  ok(r.status === 200 && r.j.item_id === '1004' && r.j.item_name === 'עמית נהרי', 'manual pick → 1004');
  // 5) לא נמצא כלל → 409 בלי הצעות → create_new
  const c3 = await mk('זיו אלמוני');
  r = await api('/api/examiner/teach/monday/send', { code: c3 });
  ok(r.status === 409 && r.j.suggestions.length === 0, '409 no suggestions: ' + r.j.error);
  r = await api('/api/examiner/teach/monday/send', { code: c3, create_new: true });
  ok(r.status === 200 && r.j.created && r.j.item_id === '2001', 'create_new → created 2001');
  const card = (await api('/api/examiner/teach/candidate/' + c3)).j;
  ok(card.monday.item_name === 'זיו אלמוני' && card.monday.fixed_board === '18414628784' && card.events.some(e => e.kind === 'monday'), 'card has item_name + fixed board + monday event');
  srv.close(); db.close && db.close();
});
