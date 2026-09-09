'use strict';
/* =========================================================================
   לקוח ל-API של monday.com — כתיבת ציונים ישירות לבורד קיים.

   ★ למה בכלל: אי אפשר להדביק בלוק תאים לגריד של מאנדיי, וייבוא Excel עם
   «Overwrite existing items» כותב את הפריט *כולו* — כלומר עלול לרוקן עמודות
   שלא נמצאות בקובץ. `change_multiple_column_values` כותב **רק את העמודות
   שנקבו בשמן** ולא נוגע בשאר, וזו הדרך היחידה שמבטיחה שלא נאבד מידע.

   הטוקן: ENV `MONDAY_API_TOKEN` (או config.local.json → mondayToken).
   ⚠ הטוקן לא נשמר במסד, לא מוחזר בשום תשובה, ולא נכתב ללוג.
   ========================================================================= */
const fs = require('fs');
const path = require('path');

// ⚠ ניתן לדריסה *רק* לצורך בדיקות מקומיות מול שרת מדומה (`MONDAY_API_URL`).
// בייצור אף פעם לא מוגדר, ולכן הכתובת האמיתית.
const ENDPOINT = process.env.MONDAY_API_URL || 'https://api.monday.com/v2';

function loadConfig() {
  let cfg = {};
  try {
    const p = path.join(__dirname, '..', 'config.local.json');
    if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { /* קובץ פגום — מתעלמים */ }
  return {
    token: process.env.MONDAY_API_TOKEN || cfg.mondayToken || null,
    // בלי כותרת גרסה מאנדיי משתמש בגרסה היציבה הנוכחית — זו ברירת המחדל
    // העמידה ביותר. אפשר לקבע אם אי פעם יישבר משהו.
    version: process.env.MONDAY_API_VERSION || cfg.mondayApiVersion || null,
  };
}
function hasToken() { return !!loadConfig().token; }

// הסבר בעברית לכל כשל — המשתמש אינו מתכנת.
function explain(status, msg) {
  if (status === 401 || status === 403) return 'הטוקן נדחה. ודאו שהועתק במלואו ל-MONDAY_API_TOKEN, ושלא פג תוקפו.';
  if (status === 429) return 'מאנדיי הגביל את קצב הבקשות. המתינו דקה ונסו שוב.';
  if (status >= 500) return 'שגיאת שרת אצל מאנדיי. נסו שוב בעוד כמה דקות.';
  if (/complexity/i.test(msg || '')) return 'הבקשה כבדה מדי למאנדיי. נסו בורד קטן יותר או פנו אליי.';
  return msg || 'שגיאה לא מזוהה מול מאנדיי.';
}

async function gql(query, variables, cfg) {
  cfg = cfg || loadConfig();
  if (!cfg.token) throw Object.assign(new Error('לא הוגדר טוקן של מאנדיי (MONDAY_API_TOKEN).'), { noToken: true });
  const headers = { 'Content-Type': 'application/json', Authorization: cfg.token };
  if (cfg.version) headers['API-Version'] = cfg.version;

  let res;
  try {
    res = await fetch(ENDPOINT, { method: 'POST', headers: headers, body: JSON.stringify({ query: query, variables: variables || {} }) });
  } catch (e) {
    throw new Error('לא הצלחנו להגיע לשרת של מאנדיי (בעיית רשת).');
  }
  let body = null;
  try { body = await res.json(); } catch (e) { /* לא JSON */ }
  if (!res.ok) throw new Error(explain(res.status, body && (body.error_message || body.errors && body.errors[0] && body.errors[0].message)));
  // ⚠ מאנדיי מחזיר 200 גם על שגיאות GraphQL — חובה לבדוק את גוף התשובה.
  if (body && body.errors && body.errors.length) throw new Error(explain(200, body.errors[0].message));
  if (body && body.error_message) throw new Error(explain(200, body.error_message));
  return (body && body.data) || {};
}

// מי אני — הקריאה הזולה ביותר, לבדיקת חיבור.
async function testToken(cfg) {
  const d = await gql('{ me { id name email } }', null, cfg);
  return d.me || null;
}

async function listBoards(cfg) {
  const d = await gql(
    'query($limit:Int!){ boards(limit:$limit, order_by:used_at, state:active){ id name items_count } }',
    { limit: 100 }, cfg);
  return (d.boards || []).map((b) => ({ id: String(b.id), name: b.name, items: b.items_count }));
}

async function boardColumns(boardId, cfg) {
  const d = await gql(
    'query($ids:[ID!]){ boards(ids:$ids){ id name columns { id title type } } }',
    { ids: [String(boardId)] }, cfg);
  const b = (d.boards || [])[0];
  if (!b) throw new Error('הבורד לא נמצא, או שאין לכם הרשאה אליו.');
  return { id: String(b.id), name: b.name, columns: (b.columns || []).map((c) => ({ id: c.id, title: c.title, type: c.type })) };
}

// כל הפריטים בבורד. ⚠ עמוד אחרי עמוד — בורד גדול לא חוזר בקריאה אחת.
async function boardItems(boardId, cfg) {
  const out = [];
  let cursor = null;
  for (let guard = 0; guard < 50; guard++) {
    const d = await gql(
      'query($ids:[ID!], $cursor:String){ boards(ids:$ids){ items_page(limit:100, cursor:$cursor){ cursor items { id name } } } }',
      { ids: [String(boardId)], cursor: cursor }, cfg);
    const page = ((d.boards || [])[0] || {}).items_page || {};
    (page.items || []).forEach((it) => out.push({ id: String(it.id), name: it.name }));
    cursor = page.cursor || null;
    if (!cursor) break;
  }
  return out;
}

// ערך התא לפי סוג העמודה. מספר ריק = ניקוי התא, ולכן מדלגים על ריקים בשכבה
// שמעל ולא שולחים אותם בכלל.
function columnValue(type, value) {
  const s = value == null ? '' : String(value);
  if (type === 'numbers') return s;
  if (type === 'long_text') return { text: s };
  return s;   // text ושאר הסוגים הטקסטואליים
}

// ★ הליבה: כותב **רק** את העמודות שב-values, ולא נוגע בשאר הפריט.
async function setValues(boardId, itemId, values, cfg) {
  await gql(
    'mutation($board:ID!, $item:ID!, $vals:JSON!){ change_multiple_column_values(board_id:$board, item_id:$item, column_values:$vals){ id } }',
    { board: String(boardId), item: String(itemId), vals: JSON.stringify(values) }, cfg);
  return true;
}

// יצירת פריט חדש בבורד (לבוחן ההוראה — המועמד לא קיים בבורד מראש).
// group_id אופציונלי; בלעדיו הפריט נכנס לקבוצה הראשונה.
async function createItem(boardId, name, values, groupId, cfg) {
  const vars = { board: String(boardId), name: String(name).slice(0, 255), vals: JSON.stringify(values || {}) };
  let q;
  if (groupId) {
    vars.group = String(groupId);
    q = 'mutation($board:ID!, $group:String!, $name:String!, $vals:JSON!){ create_item(board_id:$board, group_id:$group, item_name:$name, column_values:$vals){ id } }';
  } else {
    q = 'mutation($board:ID!, $name:String!, $vals:JSON!){ create_item(board_id:$board, item_name:$name, column_values:$vals){ id } }';
  }
  const d = await gql(q, vars, cfg);
  return d.create_item ? String(d.create_item.id) : null;
}

module.exports = { loadConfig, hasToken, gql, testToken, listBoards, boardColumns, boardItems, columnValue, setValues, createItem };
