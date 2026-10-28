#!/usr/bin/env node
/**
 * memory-tidy —— 记忆清理与优化（不花 token，纯本地规则）
 *
 * 每次跑做四件事，然后**再检查一遍，直到查不到没用的为止**：
 *   1) 清垃圾：占位符、出戏台词、指令残留、纯语气词、只有标点数字的条目
 *   2) 合并重复：同一条被写了几遍、或一条是另一条的近似改写（保留信息量大的）
 *   3) 限长限量：按句读截断（不切碎句子），话题按 TTL 清旧的，每类有上限
 *   4) 长事实压短：交给模型，条数必须一模一样，对不上就放弃
 *
 * 为什么要有「循环检查」：
 *   写回是「先清空、再逐条写」的，中途桥接重启/网络抖动会少写一条；
 *   而且整理期间她可能还在聊天，新记忆会在你清理完的那一刻又进来。
 *   所以每轮写完都重新读回来扫一遍，脏就再清一轮，最多 TIDY_ROUNDS 轮。
 *
 * 删掉的东西一律留证据：state/memory-removed.log 里逐条记着原文和删除原因。
 * 写回前还会把整份旧记忆快照到 chat-memory/tidy-<日期>.json，出问题能捞回来。
 *
 * 用法：node memory-tidy.mjs            整理并循环检查
 *       node memory-tidy.mjs --dry      只打印要做什么，不写
 *       node memory-tidy.mjs --check    只体检：列出没用的条目，不改
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE, stamp, chatKey, consoleApi as api } from '../lib/base.mjs';
import { cutText, importance, junkReason, memoryChars, norm, overlap, scanMemory, similar } from '../lib/memory-rules.mjs';

const KEY = chatKey();
const DRY = process.argv.includes('--dry') || process.env.DRY_RUN === '1';
const CHECK_ONLY = process.argv.includes('--check');

const MAX_TRAITS = Number(process.env.MAX_TRAITS || 10);
const MAX_TRAIT_CHARS = Number(process.env.MAX_TRAIT_CHARS || 120);
const MAX_TOPICS = Number(process.env.MAX_TOPICS || 12);
const TOPIC_TTL_DAYS = Number(process.env.TOPIC_TTL_DAYS || 14);
// 条数上限放高、字数预算管住：能装 60 条短事实，比只装 40 条长句子实用。
// 真正的闸门是 FACT_BUDGET_CHARS（默认 2200 字），别让"条数"误伤短而准的事实。
const MAX_FACTS = Number(process.env.MAX_FACTS || 60);
const MAX_FACT_CHARS = Number(process.env.MAX_FACT_CHARS || 60);
const MAX_TOPIC_CHARS = Number(process.env.MAX_TOPIC_CHARS || 80);
const MAX_THOUGHTS = Number(process.env.MAX_THOUGHTS || 5);
/** 最多清几轮。1 轮通常就干净了，多留几轮是给「边清边聊」的情况兜底 */
const ROUNDS = Math.max(1, Number(process.env.TIDY_ROUNDS || 3));
const REMOVED_LOG = path.join(STATE, 'memory-removed.log');
/** state 目录带「低完整性」标记，高权限进程反而写不进去；写不进去就落到 chat-memory/ */
const REMOVED_LOG_FALLBACK = path.join(ROOT, 'chat-memory', 'memory-removed.log');

function log(...a) {
  const line = `[${stamp()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(STATE, 'memory-tidy.log'), line + '\n'); } catch {}
}

/** 删掉的东西留个证据，别让人觉得记忆是她自己丢的 */
function audit(list) {
  if (!list.length) return;
  const text = list.map((x) => `[${stamp()}] ${x.cat}${x.target ? '/' + x.target : ''}｜${x.reason}｜${x.text}`).join('\n') + '\n';
  for (const f of [REMOVED_LOG, REMOVED_LOG_FALLBACK]) {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, text);
      return;
    } catch {}
  }
}

/** 去空、去垃圾、按句读截断，返回保留项和删掉的项 */
function cleanList(cat, list, maxChars, target = '') {
  const removed = [];
  const kept = [];
  for (const raw of list) {
    const t = cutText(raw, maxChars);
    const why = junkReason(t);
    if (why) {
      removed.push({ cat, target, text: String(raw || '').trim(), reason: why });
      continue;
    }
    kept.push(t);
  }
  return { kept, removed };
}

/** 去近似重复：留信息量大的（长的），删短的 */
function dedupeList(cat, list, max, maxChars, target = '') {
  const { kept, removed } = cleanList(cat, list, maxChars, target);
  const out = [];
  for (const t of kept) {
    const dup = out.findIndex((o) => similar(o, t));
    if (dup >= 0) {
      if (t.length > out[dup].length) {
        removed.push({ cat, target, text: out[dup], reason: '与另一条重复（留了更全的那条）' });
        out[dup] = t;
      } else {
        removed.push({ cat, target, text: t, reason: '与另一条重复' });
      }
      continue;
    }
    out.push(t);
  }
  out.sort((a, b) => b.length - a.length);
  for (const t of out.slice(max)) removed.push({ cat, target, text: t, reason: `超过上限 ${max} 条` });
  return { kept: out.slice(0, max), removed };
}

// ── 长句压短：这一步交给模型 ──────────────────────────────────────────
// 铁律：**条数必须一模一样**。模型只能把每条写短，不许合并、不许增删。
// 条数对不上就整个放弃，用原文。
const AI_MAX = Number(process.env.TIDY_AI_MAX || 1);

function readKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  try {
    const t = fs.readFileSync(path.join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml'), 'utf8');
    const m = t.match(/DEEPSEEK_API_KEY:\s*(sk-[A-Za-z0-9_-]+)/);
    if (m) return m[1];
  } catch {}
  return '';
}

async function compressFacts(facts) {
  if (!AI_MAX || !facts.length) return null;
  const long = facts.filter((f) => f.length > 32);
  if (!long.length) return null;
  const key = readKey();
  if (!key) { log('没有 API key，跳过 AI 压缩'); return null; }

  const prompt = `下面是一份「长期事实」列表。请把每一条改写成更短的一句结论，要求：

1. **输出条数必须和输入完全一样**，一条都不能少、不能合并、不能拆分。
2. 每条不超过 40 个字。
3. 只留结论，删掉「他说」「我说」「然后」「我嘴上应了」这类过程描写。
4. 保留所有具体信息：数字、时间、地点、口味、人名。
5. 只输出 JSON 数组，不要任何解释：["...","..."]

输入：
${JSON.stringify(facts, null, 2)}`;

  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 1500,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) { log(`AI 压缩失败：HTTP ${r.status}`); return null; }
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content || '';
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) { log('AI 压缩失败：返回里没有数组'); return null; }
    const out = JSON.parse(m[0]);
    if (!Array.isArray(out) || out.length !== facts.length) {
      log(`AI 压缩结果条数不对（${facts.length}→${Array.isArray(out) ? out.length : '非数组'}），放弃`);
      return null;
    }
    const cleaned = out.map((x) => String(x || '').trim()).filter(Boolean);
    if (cleaned.length !== facts.length) { log('AI 压缩结果有空项，放弃'); return null; }
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i].length > facts[i].length || cleaned[i].length < 4) {
        log(`AI 压缩第 ${i + 1} 条不合格（${facts[i].length}→${cleaned[i].length}），放弃`);
        return null;
      }
    }
    const saved = facts.reduce((a, f) => a + f.length, 0) - cleaned.reduce((a, f) => a + f.length, 0);
    log(`AI 压缩：${facts.length} 条，共省 ${saved} 字`);
    return cleaned;
  } catch (e) {
    log('AI 压缩异常：' + e.message);
    return null;
  }
}

// ── 读 / 写 ──────────────────────────────────────────────────────────

async function readMem() {
  const r = await api(`/api/socialV2/memory?key=${encodeURIComponent(KEY)}`);
  return r.body?.raw || null;
}

function snapshot(mem, round) {
  try {
    const dir = path.join(ROOT, 'chat-memory');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const file = path.join(dir, `tidy-${day}.json`);
    if (round > 1 && fs.existsSync(file)) return; // 当天第一轮已经存过原始状态
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), key: KEY, raw: mem }, null, 2));
  } catch (e) { log('快照失败:', e.message); }
}

/** 在内存里整理一遍，返回 {out, removed, summary} */
async function tidy(mem) {
  const removed = [];

  // 话题：先清垃圾 + 去重，再按 TTL / 上限
  const topicTexts = (mem.activeTopics || []).map((t) => String(t.text || ''));
  const topicClean = dedupeList('activeTopic', topicTexts, MAX_TOPICS * 2, MAX_TOPIC_CHARS);
  removed.push(...topicClean.removed);

  const keepTexts = new Set(topicClean.kept.map((t) => norm(t)));
  const topics = (mem.activeTopics || [])
    .filter((t) => keepTexts.has(norm(t.text)))
    .filter((t) => {
      const ts = Number(t.lastMentionAt || 0);
      if (!ts) return true;
      if (Date.now() - ts < TOPIC_TTL_DAYS * 86400000) return true;
      removed.push({ cat: 'activeTopic', text: String(t.text || ''), reason: `超过 ${TOPIC_TTL_DAYS} 天没再提` });
      return false;
    })
    // 还没聊完的事（pendingQuestion）优先留着
    .sort((a, b) => {
      const pa = a.pendingQuestion ? 1 : 0;
      const pb = b.pendingQuestion ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return Number(b.lastMentionAt || 0) - Number(a.lastMentionAt || 0);
    })
    .slice(0, MAX_TOPICS)
    .map((t) => ({ ...t, text: cutText(t.text, MAX_TOPIC_CHARS) }));

  // 印象：清垃圾 + 去重 + 限长
  const impressions = {};
  for (const [target, im] of Object.entries(mem.memberImpressions || {})) {
    if (!target || /^(undefined|null|\?|unknown)$/i.test(String(target).trim())) {
      removed.push({ cat: 'memberImpression', target, text: (im.traits || []).join('；'), reason: '印象对象不明' });
      continue;
    }
    const { kept, removed: r } = dedupeList('memberImpression', im.traits || [], MAX_TRAITS, MAX_TRAIT_CHARS, target);
    removed.push(...r);
    if (!kept.length) {
      // 一条不剩也要记账：不然就是「悄悄消失」
      removed.push({ cat: 'memberImpression', target, text: (im.traits || []).join('；'), reason: '全部被判为垃圾/重复' });
      continue;
    }
    impressions[target] = { traits: kept, interactionCount: im.interactionCount || 0, lastSeenAt: im.lastSeenAt || 0 };
  }

  // 想法：清垃圾 + 去重 + 限量
  const thoughtList = (mem.pendingThoughts || []).map((t) => (typeof t === 'string' ? t : t.text));
  const thoughtsClean = dedupeList('pendingThought', thoughtList, MAX_THOUGHTS, 120);
  removed.push(...thoughtsClean.removed);
  const thoughts = thoughtsClean.kept;

  // 长期事实：清垃圾 + 合并近似 + 压短（垃圾清掉不再补回）
  const factsIn = (mem.facts || [])
    .map((f) => (typeof f === 'string' ? f : f && f.text))
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const factsClean = dedupeList('fact', factsIn, MAX_FACTS, MAX_FACT_CHARS);
  removed.push(...factsClean.removed);
  let factsNew = factsClean.kept;
  if (!DRY && !CHECK_ONLY) {
    try {
      const shorter = await compressFacts(factsNew);
      if (shorter) factsNew = shorter;
    } catch (e) { log('压缩步骤异常（忽略）: ' + e.message); }
  }
  // 压缩后的结果再过一遍垃圾检测（模型偶尔会写出「(无)」「暂无」这种）
  const afterAI = cleanList('fact', factsNew, MAX_FACT_CHARS);
  removed.push(...afterAI.removed);
  factsNew = afterAI.kept;

  // ── 记忆预算：事实越长，每句话都要重发一遍，烧的是 token ────────────
  // 超预算时按「重要程度」砍：数字/日期/作息/健康/口味留着，「今天/刚才」这类先走。
  const FACT_BUDGET = Number(process.env.FACT_BUDGET_CHARS || 2200);
  const factChars0 = factsNew.reduce((a, s) => a + s.length, 0);
  if (factChars0 > FACT_BUDGET) {
    const scored = factsNew.map((t, i) => ({ t, i, s: importance(t) }));
    const byScore = [...scored].sort((a, b) => b.s - a.s || a.i - b.i);
    const keep = [];
    let used = 0;
    for (const x of byScore) {
      if (used + x.t.length > FACT_BUDGET) {
        removed.push({ cat: 'fact', text: x.t, reason: `超出记忆预算 ${FACT_BUDGET} 字（先留更长期有用的）` });
        continue;
      }
      used += x.t.length;
      keep.push(x);
    }
    keep.sort((a, b) => a.i - b.i); // 恢复原来的顺序，别把记忆顺序打乱
    factsNew = keep.map((x) => x.t);
    log(`记忆预算：事实 ${factChars0} 字 → ${used} 字（上限 ${FACT_BUDGET}，砍掉 ${byScore.length - keep.length} 条）`);
  }

  const out = { topics, impressions, thoughts, facts: factsNew };
  const summary =
    `话题 ${(mem.activeTopics || []).length}→${topics.length}｜` +
    `印象 ${Object.keys(mem.memberImpressions || {}).length}→${Object.keys(impressions).length} 人｜` +
    `想法 ${(mem.pendingThoughts || []).length}→${thoughts.length}｜` +
    `长期事实 ${factsIn.length}→${factsNew.length}`;
  return { out, removed, summary };
}

function writeStats(out) {
  try {
    const data = {
      at: new Date().toISOString(),
      facts: out.facts.length,
      topics: out.topics.length,
      thoughts: out.thoughts.length,
      people: Object.keys(out.impressions).length,
      traits: Object.values(out.impressions).reduce((a, v) => a + (v.traits || []).length, 0),
      chars: memoryChars(out),
    };
    fs.writeFileSync(path.join(STATE, 'memory-stats.json'), JSON.stringify(data, null, 2));
  } catch {}
}

async function writeMem(out) {
  const clearCats = ['activeTopic', 'pendingThought', 'memberImpression', 'fact'];
  for (const cat of clearCats) {
    await api('/api/socialV2/memory-clear', { method: 'POST', body: JSON.stringify({ key: KEY, category: cat }) });
  }
  for (const t of out.topics) {
    await api('/api/socialV2/memory-append', {
      method: 'POST',
      body: JSON.stringify({ key: KEY, category: 'activeTopic', content: t.text, extra: { pendingQuestion: t.pendingQuestion, participants: t.participants } }),
    });
  }
  for (const t of out.thoughts) {
    await api('/api/socialV2/memory-append', { method: 'POST', body: JSON.stringify({ key: KEY, category: 'pendingThought', content: t }) });
  }
  for (const [target, im] of Object.entries(out.impressions)) {
    for (const trait of im.traits) {
      await api('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key: KEY, category: 'memberImpression', content: trait, extra: { target } }),
      });
    }
  }
  for (const f of out.facts) {
    await api('/api/socialV2/memory-append', { method: 'POST', body: JSON.stringify({ key: KEY, category: 'fact', content: f }) });
  }
}

/** 写回后核对：数量对不上就说明中途丢了 */
function verify(expected, back) {
  const got = {
    topics: Array.isArray(back.activeTopics) ? back.activeTopics.length : 0,
    thoughts: Array.isArray(back.pendingThoughts) ? back.pendingThoughts.length : 0,
    facts: Array.isArray(back.facts) ? back.facts.length : 0,
    impr: Object.keys(back.memberImpressions || {}).length,
  };
  const bad = [];
  if (got.topics !== expected.topics.length) bad.push(`话题 ${expected.topics.length}→${got.topics}`);
  if (got.thoughts !== expected.thoughts.length) bad.push(`想法 ${expected.thoughts.length}→${got.thoughts}`);
  if (got.facts !== expected.facts.length) bad.push(`事实 ${expected.facts.length}→${got.facts}`);
  if (got.impr !== Object.keys(expected.impressions).length) bad.push(`印象 ${Object.keys(expected.impressions).length}→${got.impr}`);
  return bad;
}

/**
 * 不许「悄悄变少」。
 *
 * 2026-10-28 真出过事：整理完，「哥」的那两条印象没了，日志里却一条删除记录都没有——
 * 因为它是在中间环节丢的（不是被判为垃圾），而当时的校验只比「几个人」，没比「几条」。
 * 所以这里做一道硬账：**每一类少了多少条，就必须有同样多条的删除记录**。
 * 对不上就不写，直接退回快照，宁可不整理。
 */
function lossCheck(mem, out, removed) {
  const traitsOf = (m) => Object.values(m.memberImpressions || {}).reduce((a, v) => a + (Array.isArray(v?.traits) ? v.traits.length : 0), 0);
  const before = {
    fact: (mem.facts || []).length,
    activeTopic: (mem.activeTopics || []).length,
    pendingThought: (mem.pendingThoughts || []).length,
    memberImpression: traitsOf(mem),
  };
  const after = {
    fact: out.facts.length,
    activeTopic: out.topics.length,
    pendingThought: out.thoughts.length,
    memberImpression: Object.values(out.impressions || {}).reduce((a, v) => a + (v.traits || []).length, 0),
  };
  const logged = { fact: 0, activeTopic: 0, pendingThought: 0, memberImpression: 0 };
  for (const r of removed) if (logged[r.cat] !== undefined) logged[r.cat] += 1;

  const bad = [];
  for (const cat of Object.keys(before)) {
    const gone = before[cat] - after[cat];
    if (gone <= 0) continue;
    // 印象可能整组消失（人没了）：那种也算一笔，但至少要有记录
    if (gone > logged[cat]) bad.push(`${cat} 少了 ${gone} 条，但只有 ${logged[cat]} 条删除记录`);
  }
  return bad;
}


/**
 * 模型复审：规则抓不到「换个说法但说的是同一件事」，交给模型找重复。
 *
 * 约束（比模型本身更重要）：
 *   · 只允许两种理由：重复（必须指出跟哪条重复）、出戏/空话
 *   · 长期事实只许删「重复」——事实是只增不删那层，不能凭"感觉不重要"砍
 *   · 每类最多删 30%，facts 最少留 3 条
 *   · 它说删什么就记进 memory-removed.log，谁删的、为什么，一条不落
 */
async function aiJudge(out) {
  if (process.env.TIDY_AI_JUDGE === '0') return [];
  const items = [];
  const push = (id, cat, text, target) => items.push({ id, cat, text, target });
  out.facts.forEach((f, i) => push(`F${i + 1}`, 'fact', f));
  out.topics.forEach((t, i) => push(`T${i + 1}`, 'activeTopic', t.text));
  out.thoughts.forEach((t, i) => push(`H${i + 1}`, 'pendingThought', t));
  for (const [target, im] of Object.entries(out.impressions)) {
    im.traits.forEach((tr, i) => push(`I${target}#${i + 1}`, 'memberImpression', tr, target));
  }
  if (items.length < 6) return [];          // 太少，没必要花钱

  const key = readKey();
  if (!key) { log('没有 API key，跳过 AI 复审'); return []; }

  const prompt = `下面是一个聊天机器人的「记忆」。请只找出**重复**的条目。

规则：
1. 只挑你有把握的；拿不准一律不删。宁可漏，不可错。
2. 判断标准：两条说的是**同一件事**，只是换了说法或一条更全。只是话题相邻、主角相同，不算重复。
3. 必须给出 dupOf，指向同一类里更完整的那条的 id。
4. 你**不许**判断"重要不重要""有没有意思"——那种事轮不到你。
5. 只输出 JSON，不要解释：{"delete":[{"id":"T5","dupOf":"T3"}]}
6. 没有可删的就输出 {"delete":[]}

条目：
${items.map((x) => `${x.id}｜${x.text}`).join('\n')}`;

  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) { log(`AI 复审失败：HTTP ${r.status}`); return []; }
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    const list = Array.isArray(parsed.delete) ? parsed.delete : [];

    const byId = new Map(items.map((x) => [x.id, x]));
    const perCat = {};
    const picked = [];
    for (const d of list) {
      const it = byId.get(String(d.id || ''));
      if (!it) continue;
      // 只认「重复」，并且必须指出跟谁重复；"出戏/空话"这类判断交给上面的规则，
      // 不让模型碰 —— 2026-10-28 它把一个正经话题（炒饭的照片）标成了"空话"。
      const dup = byId.get(String(d.dupOf || ''));
      if (!dup || dup.cat !== it.cat || dup.id === it.id) continue;
      // 硬约束：说的得真是同一件事。模型 2026-10-28 把「问眼药水」判成「好笑的」
      // 的重复，差点删掉一条真记忆 —— 从那以后必须自己再验一遍字面重合度。
      if (overlap(it.text, dup.text) < 0.2) {
        log(`AI 说 ${it.id} 与 ${dup.id} 重复，但字面重合度只有 ${overlap(it.text, dup.text).toFixed(2)}，不删`);
        continue;
      }
      perCat[it.cat] = perCat[it.cat] || { n: 0, picked: [] };
      perCat[it.cat].n += 1;
      perCat[it.cat].picked.push(it);
      picked.push({ ...it, why: `AI：与 ${d.dupOf} 重复` });
    }

    // 每类最多删 30%，facts 至少留 3 条
    const out2 = [];
    const total = {};
    for (const it of items) total[it.cat] = (total[it.cat] || 0) + 1;
    const allowed = (cat) => {
      const t = total[cat] || 0;
      let cap = Math.max(1, Math.floor(t * 0.3));
      if (cat === 'fact') cap = Math.min(cap, Math.max(0, t - 3));
      return cap;
    };
    const used = {};
    for (const p of picked) {
      used[p.cat] = (used[p.cat] || 0) + 1;
      if (used[p.cat] > allowed(p.cat)) continue;
      out2.push(p);
    }
    if (out2.length) log(`AI 复审：建议删 ${out2.length} 条（${out2.map((x) => x.id + ' ' + x.why).join('；')}）`);
    return out2.map((x) => ({ cat: x.cat, target: x.target || '', text: x.text, reason: x.why, id: x.id }));
  } catch (e) {
    log('AI 复审异常：' + e.message);
    return [];
  }
}

/** 把 AI 挑出来的条目从 out 里摘掉 */
function applyJudge(out, judged) {
  const drop = new Set(judged.map((j) => j.id));
  const facts = out.facts.filter((_, i) => !drop.has(`F${i + 1}`));
  const topics = out.topics.filter((_, i) => !drop.has(`T${i + 1}`));
  const thoughts = out.thoughts.filter((_, i) => !drop.has(`H${i + 1}`));
  const impressions = {};
  for (const [target, im] of Object.entries(out.impressions)) {
    const traits = im.traits.filter((_, i) => !drop.has(`I${target}#${i + 1}`));
    if (traits.length) impressions[target] = { ...im, traits };
  }
  return { topics, impressions, thoughts, facts };
}

const scan = scanMemory;

// ── 主流程：清 → 写 → 再读回来查 → 还脏就再清 ────────────────────────

async function main() {
  const mem0 = await readMem();
  if (!mem0) { log('读不到记忆，退出'); return; }

  // 纯体检模式：只报告
  if (CHECK_ONLY) {
    const junk = scan(mem0);
    const probe = {
      facts: (mem0.facts || []).map((f) => (typeof f === 'string' ? f : f.text)),
      topics: mem0.activeTopics || [],
      thoughts: (mem0.pendingThoughts || []).map((t) => (typeof t === 'string' ? t : t.text)),
      impressions: mem0.memberImpressions || {},
    };
    const judged = await aiJudge(probe);
    if (!junk.length && !judged.length) { log('体检：没有发现没用的条目'); return; }
    log(`体检：规则发现 ${junk.length} 条，模型发现 ${judged.length} 条`);
    for (const j of junk) log(`  · [${j.cat}${j.target ? '/' + j.target : ''}] ${j.reason} ｜ ${j.text.slice(0, 60)}`);
    for (const j of judged) log(`  · [${j.cat}${j.target ? '/' + j.target : ''}] ${j.reason} ｜ ${j.text.slice(0, 60)}`);
    return;
  }

  let snapshotDone = false;
  for (let round = 1; round <= ROUNDS; round++) {
    const mem = round === 1 ? mem0 : await readMem();
    if (!mem) { log(`第 ${round} 轮：读不到记忆，退出`); break; }

    const junkBefore = scan(mem);
    let { out, removed } = await tidy(mem);

    // 规则清完，再让模型找一遍「换个说法但说的是同一件事」和出戏台词
    const judged = await aiJudge(out);
    if (judged.length) {
      out = applyJudge(out, judged);
      removed = [...removed, ...judged];
    }

    const summary =
      `话题 ${(mem.activeTopics || []).length}→${out.topics.length}｜` +
      `印象 ${Object.keys(mem.memberImpressions || {}).length}→${Object.keys(out.impressions).length} 人｜` +
      `想法 ${(mem.pendingThoughts || []).length}→${out.thoughts.length}｜` +
      `长期事实 ${(mem.facts || []).length}→${out.facts.length}`;

    // 用「同样的形状」比对，判断这轮到底改了什么（不想因为字段顺序误判成有变化）
    const flat = (m) => ({
      topics: (m.activeTopics || []).map((t) => t.text),
      thoughts: (m.pendingThoughts || []).map((t) => (typeof t === 'string' ? t : t.text)),
      facts: (m.facts || []).map((f) => (typeof f === 'string' ? f : f.text)),
      impressions: Object.fromEntries(Object.entries(m.memberImpressions || {}).map(([k, v]) => [k, v.traits || []])),
    });
    const changed = JSON.stringify(flat(mem)) !== JSON.stringify(out);

    // 硬账：少了多少条，就必须有同样多的删除记录，否则宁可不写
    const lost = lossCheck(mem, out, removed);
    if (lost.length) {
      log('⚠️ 有记忆在整理过程中凭空变少（' + lost.join('，') + '），这次不写，保留原样');
      break;
    }

    if (!removed.length && !changed) {
      log(`第 ${round} 轮：干净了${round > 1 ? '（已清完）' : '，无需改动'}`);
      if (round === 1) log('记忆已经是最优状态');
      writeStats(out); // 干净时也记一笔，self-check 才有得比
      break;
    }

    if (DRY) {
      log(`[dry-run] 第 ${round} 轮：`, summary, `｜将删除 ${removed.length} 条`);
      for (const r of removed) log(`  - [${r.cat}${r.target ? '/' + r.target : ''}] ${r.reason} ｜ ${r.text.slice(0, 60)}`);
      break;
    }

    if (!snapshotDone) { snapshot(mem, 1); snapshotDone = true; }

    log(`第 ${round} 轮：${summary}｜删除 ${removed.length} 条${junkBefore.length ? `（其中 ${junkBefore.length} 条是垃圾）` : ''}`);
    for (const r of removed) log(`  - [${r.cat}${r.target ? '/' + r.target : ''}] ${r.reason} ｜ ${r.text.slice(0, 60)}`);

    await writeMem(out);
    audit(removed);
    writeStats(out);

    const back = await readMem();
    if (!back) { log('写回后读不回来，停手'); break; }
    const bad = verify(out, back);
    if (bad.length) {
      log('⚠️ 写回后数量对不上（' + bad.join('，') + '），用快照恢复');
      snapshotRestore(mem);
      break;
    }

    // 关键一步：写完了再查一遍，脏就继续下一轮
    const left = scan(back);
    if (!left.length) { log(`第 ${round} 轮写回校验通过，检查过：没有没用的了`); break; }
    log(`第 ${round} 轮写完复查：还剩 ${left.length} 条没用的，再清一轮`);
    if (round === ROUNDS) log('已达最大轮数，剩下的下次再清');
  }
}

async function snapshotRestore(mem) {
  try {
    await writeMem({
      topics: (mem.activeTopics || []).map((t) => ({ ...t })),
      impressions: Object.fromEntries(Object.entries(mem.memberImpressions || {}).map(([k, v]) => [k, { traits: [...(v.traits || [])], interactionCount: v.interactionCount || 0, lastSeenAt: v.lastSeenAt || 0 }])),
      thoughts: (mem.pendingThoughts || []).map((t) => t.text || t),
      facts: (mem.facts || []).map((f) => (typeof f === 'string' ? f : f.text)).filter(Boolean),
    });
    log('已从快照恢复');
  } catch (e) { log('恢复失败（快照文件还在 chat-memory/）:', e.message); }
}

await main();
