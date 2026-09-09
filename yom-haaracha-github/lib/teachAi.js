'use strict';
/* =========================================================================
   בוחן ההוראה — בדיקת AI לתשובות הכתובות.

   ה-AI *מציע* — לכל שורה ברובריקה: התקיים / לא התקיים, עם ציטוט קצר מהתשובה
   כראיה, ומסקנה של שורה בעברית. הבודק מאשר או משנה בכרטיס — ההחלטה האנושית
   גוברת, והציון הסופי הוא מה שהבודק סימן.

   מפתח API כמו ב-lib/aiGrade.js (ANTHROPIC_API_KEY / config.local.json).
   בלי מפתח → מצב הדגמה (demo:true): סימון לפי אורך בלבד, כדי לראות את הזרימה.
   ========================================================================= */
const Anthropic = require('@anthropic-ai/sdk');
const AnthropicClient = Anthropic.default || Anthropic;
const { loadConfig } = require('./aiGrade');

let _client = null, _key = null;
function client(cfg) {
  if (_client && _key === cfg.apiKey) return _client;
  _client = new AnthropicClient({ apiKey: cfg.apiKey, maxRetries: 4, timeout: 5 * 60 * 1000 });
  _key = cfg.apiKey;
  return _client;
}

const SYSTEM = [
  'אתה בודק מבחן קבלה למורים בישראל (עתיד פלוס). המועמד ענה על שאלה פדגוגית קצרה.',
  'לפניך: השאלה, מפתח הבדיקה (מה תשובה חזקה אומרת, ומה הדגל האדום), רובריקה של קריטריונים, והתשובה של המועמד.',
  'לכל קריטריון קבע האם הוא התקיים בתשובה — בשמרנות: קריטריון מתקיים רק אם הוא כתוב במפורש או נובע ישירות, לא אם "אפשר להבין" אותו.',
  'לכל קריטריון צטט עד 12 מילים מהתשובה כראיה (או השאר ריק אם לא התקיים).',
  'כתוב מסקנה של שורה אחת בעברית לבודק האנושי — מה הכי חשוב לשים לב אליו.',
  'אל תעניק נקודות על אורך, על שטף או על מילים יפות. תשובה כללית שלא נוגעת בשלב/בתלמיד/בשאלה הספציפית — לא מקיימת את הקריטריונים.',
  'החזר JSON בלבד לפי הסכמה.',
].join('\n');

function schemaFor(criteria) {
  const props = {};
  criteria.forEach(function (c) {
    props[c] = {
      type: 'object',
      properties: { met: { type: 'boolean' }, evidence: { type: 'string' } },
      required: ['met', 'evidence'], additionalProperties: false,
    };
  });
  return {
    type: 'object',
    properties: {
      criteria: { type: 'object', properties: props, required: criteria, additionalProperties: false },
      conclusion: { type: 'string' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['criteria', 'conclusion', 'confidence'], additionalProperties: false,
  };
}

function isBlank(t) { return !String(t || '').trim(); }

function demo(q) {
  const len = String(q.answer || '').trim().length;
  const crit = {};
  q.criteria.forEach(function (c, i) { crit[c] = { met: len > 60 + i * 50, evidence: '' }; });
  return { ok: true, demo: true, criteria: crit, confidence: 'low',
    conclusion: 'מצב הדגמה (אין מפתח API) — הסימון לפי אורך בלבד. יש לבדוק ידנית.' };
}

function blank(q) {
  const crit = {};
  q.criteria.forEach(function (c) { crit[c] = { met: false, evidence: '' }; });
  return { ok: true, demo: false, criteria: crit, confidence: 'high', conclusion: 'לא נענה.' };
}

// q = { qid, subject, question, key, criteria:[id], labels:{id:label}, answer, context }
async function gradeOne(q, cfg) {
  cfg = cfg || loadConfig();
  if (isBlank(q.answer)) return blank(q);
  if (!cfg.apiKey) return demo(q);

  const lines = q.criteria.map(function (c) { return '- ' + c + ': ' + (q.labels[c] || c); }).join('\n');
  const user = [
    'מקצוע: ' + q.subject,
    q.context ? ('הקשר (מה המועמד ראה):\n' + q.context) : '',
    'השאלה למועמד:\n' + q.question,
    'מפתח הבדיקה:\n' + q.key,
    'הרובריקה (מזהה: תיאור):\n' + lines,
    'התשובה של המועמד:\n"""\n' + String(q.answer).slice(0, 2500) + '\n"""',
  ].filter(Boolean).join('\n\n');

  try {
    const res = await client(cfg).messages.create({
      model: cfg.model,
      max_tokens: 1500,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: cfg.effort, format: { type: 'json_schema', schema: schemaFor(q.criteria) } },
      messages: [{ role: 'user', content: user }],
    });
    if (res.stop_reason === 'refusal') throw new Error('נדחה ע"י מסנני הבטיחות.');
    const text = (res.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    const parsed = JSON.parse(text);
    const crit = {};
    q.criteria.forEach(function (c) {
      const e = (parsed.criteria || {})[c] || {};
      crit[c] = { met: !!e.met, evidence: String(e.evidence || '').slice(0, 160) };
    });
    return { ok: true, demo: false, criteria: crit,
      conclusion: String(parsed.conclusion || '').slice(0, 300),
      confidence: ['high', 'medium', 'low'].indexOf(parsed.confidence) >= 0 ? parsed.confidence : 'medium' };
  } catch (e) {
    const crit = {};
    q.criteria.forEach(function (c) { crit[c] = { met: false, evidence: '' }; });
    return { ok: false, demo: false, criteria: crit, confidence: 'low', error: true,
      conclusion: 'שגיאת בדיקה: ' + String(e.message || e).slice(0, 160) + ' — יש לבדוק ידנית.' };
  }
}

// כל השאלות של מועמד אחד, בזו אחר זו (מועמד אחד = 5–6 קריאות קטנות).
async function gradeMany(list, cfg) {
  cfg = cfg || loadConfig();
  const out = {};
  for (const q of list) out[q.qid] = await gradeOne(q, cfg);
  return out;
}

module.exports = { gradeOne, gradeMany, loadConfig };
