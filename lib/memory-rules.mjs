/**
 * lib/memory-rules.mjs —— 「什么算没用的记忆」这套判断，只此一份
 *
 * 为什么要单独抽出来：memory-tidy 每天清、self-check 每天查、regression 发布前验，
 * 三处必须用**同一套规则**，否则会出现「tidy 删掉的 self-check 说还在」这种自相矛盾。
 *
 * 这里全是纯函数，没有副作用、不碰网络，谁都能 import。
 */

/** 归一化：去空白、去标点、转小写，用于判重 */
export function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。；、,.;!?！？:：~～…—\-（）()"'"'《》]/g, '');
}

/** 中文按二字切片，比单个字更能看出「是不是同一句话」 */
export function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 两条的二字重合度，0~1 */
export function overlap(a, b) {
  const x = bigrams(norm(a));
  const y = bigrams(norm(b));
  if (x.size < 3 || y.size < 3) return 0;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter += 1;
  return inter / (x.size + y.size - inter);
}

/** 近似判定：完全相同 / 一条是另一条的前缀 / 字重合度高 / 二字切片重合度高 */
export function similar(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 8 && y.length >= 8 && (x.startsWith(y) || y.startsWith(x))) return true;

  const sx = new Set(x);
  const sy = new Set(y);
  let inter = 0;
  for (const ch of sx) if (sy.has(ch)) inter += 1;
  const union = sx.size + sy.size - inter;
  if (union > 0 && inter / union >= 0.85) return true;

  return overlap(a, b) >= 0.72;
}

/** 截断：优先切在句读上，别把一句话切成「…；妹」这种残句 */
export function cutText(s, max) {
  const t = String(s || '').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const at = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('！'),
    head.lastIndexOf('？'), head.lastIndexOf('，'), head.lastIndexOf(' '),
  );
  if (at >= Math.floor(max * 0.6)) return head.slice(0, at).trim();
  return head.trim();
}

/** 纯语气词/寒暄 */
const FILLER = /^[嗯啊哦噢好行对是哈呵嘿啦呀吧的吗呢么了收到在]+$/;
/** 只有标点、符号、数字、空白 */
const ONLY_SYMBOLS = /^[\p{P}\p{S}\d\s]+$/u;

/**
 * 这条记忆是不是垃圾/污染。返回原因（空串 = 没问题）。
 * 只认**明确的**坏：拿不准的一律留着 —— 记忆宁可多一条，不要错删一条。
 */
export function junkReason(text) {
  const t = String(text || '').trim();
  if (!t) return '空条目';
  if (t.length < 4) return '太短，没有信息量';
  if (/^(.)\1{3,}$/.test(t)) return '同一个字重复';

  const rules = [
    ['占位符/脏数据', /<BOT_NAME>|YOUR_QQ|YOUR_BOT_QQ|YOUR_PC|undefined|\bnull\b|NaN|\[object Object\]|TODO|占位/i],
    ['出戏/meta 台词', /我是\s*AI|作为(一个)?\s*(AI|助手|语言模型)|语言模型|系统提示|根据聊天(记录)?|聊天记录显示|以上是|以下是|无法确定|抱歉[，,]/],
    ['指令/提示词残留', /请把|请提炼|输出\s*JSON|system\s*prompt|提示词/],
    ['代码或链接', /https?:\/\/|```|function\s*\(|=>|<\/?[a-z][a-z0-9]*>/],
    ['只有符号或数字', ONLY_SYMBOLS],
    ['只有语气词', FILLER],
  ];
  for (const [why, re] of rules) if (re.test(t)) return why;
  return '';
}

/**
 * 重要程度：记忆要砍的时候，先砍分低的。
 * 数字/日期/作息/健康/口味 = 长期有用；「今天/刚才」这类时效性强的往下压。
 */
export function importance(text) {
  const t = String(text || '');
  let s = 0;
  if (/\d/.test(t)) s += 3;
  if (/爱|喜欢|不吃|忌口|生日|上班|睡|起床|药|眼镜|过敏|工资|收入/.test(t)) s += 2;
  s += Math.min(3, Math.floor(t.length / 20));
  if (/今天|刚才|刚刚|昨天|这会儿/.test(t)) s -= 2;
  return s;
}

// ── 欠账（小账本）────────────────────────────────────────────────────
// 记忆是摘要，摘要会压糊数字：2026-10-29 那条「鸭腿债：摸尾巴换十根盐焗鸭腿…
// 另有两隻卤香鸭腿（打五折）」就是被压缩出来的糊账。所以欠账单独用**固定格式**
// 存进 facts，并且 memory-tidy 不许压它、不许并它、不许截它。
//
// 格式：欠账｜内容×数量｜YYYY-MM-DD[｜已结]
//   · 没写状态 = 未结；只存未结的，还清了把那条删掉
//   · 分隔符全角半角都认，读的时候统一成全角
//   · 不超过 60 字（桥接那层 facts 硬截 60，超了就丢字）
export const DEBT_HEAD = '欠账｜';
export const DEBT_MAX_CHARS = 60;

/** 是不是一条欠账（前缀判定，宽容全角/半角分隔符与多余空格） */
export function isDebt(text) {
  return /^欠账\s*[｜|]/.test(String(text || '').trim());
}

/** 拆一条欠账：{ content, date, settled }；不是欠账/拆不出来返回 null */
export function debtParse(text) {
  const t = String(text || '').trim().replace(/\|/g, '｜');
  const m = /^欠账\s*｜(.*)$/.exec(t);
  if (!m) return null;
  const parts = m[1].split('｜').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  let settled = false;
  const status = parts[parts.length - 1];
  if (status === '已结' || status === '未结') {
    settled = status === '已结';
    parts.pop();
  }
  let date = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(parts[parts.length - 1] || '')) date = parts.pop();
  const content = parts.join('｜').trim();
  if (!content) return null;
  return { content, date, settled };
}

/** 拼回固定格式；date 缺了就用今天 */
export function formatDebt({ content, date, settled } = {}) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : new Date().toISOString().slice(0, 10);
  const body = String(content || '').trim();
  if (!body) return '';
  return `${DEBT_HEAD}${body}｜${d}${settled ? '｜已结' : ''}`;
}

/** 欠了多少天（没有日期返回 0） */
export function debtAgeDays(text, now = Date.now()) {
  const p = debtParse(text);
  if (!p || !p.date) return 0;
  const t = Date.parse(p.date + 'T00:00:00+08:00');
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 86400000));
}

/** 把一条欠账整成规范格式 + 保住 ≤60 字（超了只截内容，不碰日期/状态） */
export function fitDebt(text) {
  const p = debtParse(text);
  if (!p) return '';
  let s = formatDebt(p);
  if (s.length <= DEBT_MAX_CHARS) return s;
  const tail = `｜${p.date}${p.settled ? '｜已结' : ''}`;
  const room = DEBT_MAX_CHARS - DEBT_HEAD.length - tail.length;
  if (room < 4) return '';
  const head = p.content.slice(0, room).trim();
  return head ? `${DEBT_HEAD}${head}${tail}` : '';
}

/** 扫一份记忆，列出所有「没用的」条目（不改数据） */
export function scanMemory(mem) {
  const found = [];
  for (const t of mem.activeTopics || []) {
    const why = junkReason(t.text);
    if (why) found.push({ cat: 'activeTopic', text: String(t.text || ''), reason: why });
  }
  for (const t of mem.pendingThoughts || []) {
    const why = junkReason(typeof t === 'string' ? t : t.text);
    if (why) found.push({ cat: 'pendingThought', text: String(typeof t === 'string' ? t : t.text || ''), reason: why });
  }
  for (const [target, im] of Object.entries(mem.memberImpressions || {})) {
    for (const trait of im.traits || []) {
      const why = junkReason(trait);
      if (why) found.push({ cat: 'memberImpression', target, text: String(trait || ''), reason: why });
    }
  }
  for (const f of mem.facts || []) {
    const text = typeof f === 'string' ? f : f && f.text;
    const why = junkReason(text);
    if (why) found.push({ cat: 'fact', text: String(text || ''), reason: why });
  }
  return found;
}

/** 记忆总字符数（注入提示词时大致就是这个量级） */
export function memoryChars(mem) {
  const facts = (mem.facts || []).map((f) => (typeof f === 'string' ? f : f.text) || '');
  const topics = (mem.activeTopics || []).map((t) => t.text || '');
  const thoughts = (mem.pendingThoughts || []).map((t) => (typeof t === 'string' ? t : t.text) || '');
  const traits = Object.values(mem.memberImpressions || {}).flatMap((v) => v.traits || []);
  return [...facts, ...topics, ...thoughts, ...traits].reduce((a, s) => a + s.length, 0);
}
