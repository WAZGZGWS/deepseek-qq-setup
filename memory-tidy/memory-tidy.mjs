#!/usr/bin/env node
/**
 * memory-tidy —— 记忆自动优化（不花 token，纯本地规则）
 *
 * 从桥接的记忆里读出来，做四件事再写回去：
 *   1) 印象里的重复/近似条目合并（保留信息量最大的几条）
 *   2) 每条印象截断到 MAX_TRAIT 字，最多保留 MAX_TRAITS 条
 *   3) 进行中的话题超过 TOPIC_TTL_DAYS 天没再提，删掉
 *   4) 话题最多 MAX_TOPICS 条，优先保留最近的
 *
 * 写回前会把旧记忆快照到 chat-memory/tidy-<日期>.json
 * 用法：node memory-tidy.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE, stamp, chatKey, consoleApi as api } from '../lib/base.mjs';

const KEY = chatKey();
const DRY = process.argv.includes('--dry') || process.env.DRY_RUN === '1';

const MAX_TRAITS = Number(process.env.MAX_TRAITS || 10);
const MAX_TRAIT_CHARS = Number(process.env.MAX_TRAIT_CHARS || 120);
const MAX_TOPICS = Number(process.env.MAX_TOPICS || 12);
const TOPIC_TTL_DAYS = Number(process.env.TOPIC_TTL_DAYS || 14);
const MAX_FACTS = Number(process.env.MAX_FACTS || 40);
const MAX_FACT_CHARS = Number(process.env.MAX_FACT_CHARS || 60);
const MAX_TOPIC_CHARS = Number(process.env.MAX_TOPIC_CHARS || 80);

function log(...a) {
  const line = `[${stamp()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(STATE, 'memory-tidy.log'), line + '\n'); } catch {}
}

/** 归一化：去空白、去重复标点，用于判重 */
function norm(s) {
  return String(s || '').replace(/\s+/g, '').replace(/[，。；、,.;!?！？]/g, '');
}

/** 近似判定：一条是另一条的前缀，或重合度很高 */
function similar(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 8 && y.length >= 8 && (x.startsWith(y) || y.startsWith(x))) return true;
  // 交集/并集
  const sx = new Set(x), sy = new Set(y);
  let inter = 0;
  for (const ch of sx) if (sy.has(ch)) inter += 1;
  const union = sx.size + sy.size - inter;
  return union > 0 && inter / union >= 0.85;
}

function dedupeList(list, max, maxChars) {
  const out = [];
  for (const raw of list) {
    const t = String(raw || '').trim().slice(0, maxChars);
    if (!t) continue;
    if (out.some((o) => similar(o, t))) continue;
    out.push(t);
  }
  // 信息量优先：长的在前
  out.sort((a, b) => b.length - a.length);
  return out.slice(0, max);
}

// ── 长句压短：这一步交给模型 ──────────────────────────────────────────
// 实测 2026-10-28 的事实里有这种：
//   「哥说过：余额不够用一定要第一时间跟他说，他给充；我嘴上应了『真不够第一个找你』」
// 39 个字，半句是过程。事实应该是「钱不够第一时间找哥要」，一句话说完。
//
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
  if (!long.length) return null;               // 都不长，没必要花这个钱
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
    // 逐条比对：新的一条不能比原来长，也不能短到几乎没有信息
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
async function main() {
  const mem = (await api(`/api/socialV2/memory?key=${encodeURIComponent(KEY)}`)).body?.raw;
  if (!mem) { log('读不到记忆，退出'); return; }

  // 快照
  try {
    const dir = path.join(ROOT, 'chat-memory');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    fs.writeFileSync(path.join(dir, `tidy-${day}.json`), JSON.stringify({ at: new Date().toISOString(), key: KEY, raw: mem }, null, 2));
  } catch (e) { log('快照失败:', e.message); }

  const topics = (mem.activeTopics || []).filter((t) => {
    const ts = Number(t.lastMentionAt || 0);
    if (!ts) return true;
    return Date.now() - ts < TOPIC_TTL_DAYS * 86400000;
  })
    // 还没聊完的事（pendingQuestion）优先留着，别因为"旧"就砍掉
    .sort((a, b) => {
      const pa = a.pendingQuestion ? 1 : 0;
      const pb = b.pendingQuestion ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return Number(b.lastMentionAt || 0) - Number(a.lastMentionAt || 0);
    })
    .slice(0, MAX_TOPICS)
    .map((t) => ({ ...t, text: String(t.text || '').trim().slice(0, MAX_TOPIC_CHARS) }));

  const impressions = {};
  for (const [target, im] of Object.entries(mem.memberImpressions || {})) {
    const traits = dedupeList(im.traits || [], MAX_TRAITS, MAX_TRAIT_CHARS);
    impressions[target] = { traits, interactionCount: im.interactionCount || 0, lastSeenAt: im.lastSeenAt || 0 };
  }

  const thoughts = dedupeList((mem.pendingThoughts || []).map((t) => t.text), 5, 120);

  // ── 长期事实：合并近似的、压缩冗长的，但**一条都不许丢** ──────────────
  // facts 是只增不删的那一层，之前靠 "超过 30 条丢最旧的" 兜底，
  // 等于聊久了就开始忘早期的事。这里改成先合并重复，实在超过 40 条再谈上限。
  const factsIn = (mem.facts || [])
    .map((f) => (typeof f === 'string' ? f : f && f.text))
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const facts = [];
  let mergedFacts = 0;
  for (const raw of factsIn) {
    const t = raw.slice(0, MAX_FACT_CHARS);
    const dup = facts.findIndex((f) => similar(f, t));
    if (dup >= 0) {
      // 留信息更全的那条，不是留新的那条
      if (t.length > facts[dup].length && !facts[dup].includes(t)) facts[dup] = t;
      mergedFacts += 1;
      continue;
    }
    facts.push(t);
  }
  let factsNew = facts.slice(0, MAX_FACTS);
  // 长句压短（条数不变）。失败就用原文，不影响其它步骤。
  if (!DRY) {
    try {
      const shorter = await compressFacts(factsNew);
      if (shorter) factsNew = shorter;
    } catch (e) { log('压缩步骤异常（忽略）: ' + e.message); }
  }
  const factsChanged = factsNew.length !== factsIn.length || factsNew.some((f, i) => f !== factsIn[i]);

  const before = JSON.stringify(mem);
  const after = JSON.stringify({ topics, impressions, thoughts, facts: factsNew });
  if (before === after) { log('记忆已经是最优状态，无需改动'); return; }

  const summary =
    `话题 ${(mem.activeTopics || []).length}→${topics.length}｜` +
    `印象 ${Object.keys(mem.memberImpressions || {}).length}→${Object.keys(impressions).length} 人｜` +
    `想法 ${(mem.pendingThoughts || []).length}→${thoughts.length}｜` +
    `长期事实 ${factsIn.length}→${factsNew.length}` +
    (mergedFacts ? `（合并 ${mergedFacts} 条重复）` : '');
  if (DRY) { log('[dry-run]', summary); return; }

  // 分类别清空。fact 默认不动 —— 只有真的合并/压缩过头了才重建一遍，
  // 重建前已经快照到 chat-memory/tidy-<日期>.json，出问题能捞回来。
  const clearCats = ['activeTopic', 'pendingThought', 'memberImpression'];
  if (factsChanged && factsNew.length > 0) clearCats.push('fact');
  for (const cat of clearCats) {
    await api('/api/socialV2/memory-clear', { method: 'POST', body: JSON.stringify({ key: KEY, category: cat }) });
  }
  for (const t of topics) {
    await api('/api/socialV2/memory-append', {
      method: 'POST',
      body: JSON.stringify({ key: KEY, category: 'activeTopic', content: t.text, extra: { pendingQuestion: t.pendingQuestion, participants: t.participants } }),
    });
  }
  for (const t of thoughts) {
    await api('/api/socialV2/memory-append', { method: 'POST', body: JSON.stringify({ key: KEY, category: 'pendingThought', content: t }) });
  }
  for (const [target, im] of Object.entries(impressions)) {
    for (const trait of im.traits) {
      await api('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key: KEY, category: 'memberImpression', content: trait, extra: { target } }),
      });
    }
  }
  if (clearCats.includes('fact')) {
    for (const f of factsNew) {
      await api('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key: KEY, category: 'fact', content: f }),
      });
    }
  }
  // ── 写后对账：数量对不上就用快照恢复 ────────────────────────────
  // 整理是「先全清空、再逐条写回」。中途只要有一个请求失败（网络抖动、桥接重启），
  // 那一类记忆就永久少了一截，而且没人会发现 —— 快照虽然写了，但没人去比。
  const back = (await api(`/api/socialV2/memory?key=${encodeURIComponent(KEY)}`)).body?.raw;
  if (back) {
    const gotTopics = Array.isArray(back.activeTopics) ? back.activeTopics.length : 0;
    const gotThoughts = Array.isArray(back.pendingThoughts) ? back.pendingThoughts.length : 0;
    const gotFacts = Array.isArray(back.facts) ? back.facts.length : 0;
    const factOk = clearCats.includes('fact') ? gotFacts === factsNew.length : true;
    const bad = [];
    if (gotTopics !== topics.length) bad.push(`话题 ${topics.length}→${gotTopics}`);
    if (gotThoughts !== thoughts.length) bad.push(`想法 ${thoughts.length}→${gotThoughts}`);
    if (!factOk) bad.push(`事实 ${factsNew.length}→${gotFacts}`);

    if (bad.length) {
      log('⚠️ 写回后数量对不上（' + bad.join('，') + '），用快照恢复原始记忆');
      for (const cat of ['activeTopic', 'pendingThought', 'memberImpression', 'fact']) {
        await api('/api/socialV2/memory-clear', { method: 'POST', body: JSON.stringify({ key: KEY, category: cat }) });
      }
      for (const t2 of mem.activeTopics || []) {
        await api('/api/socialV2/memory-append', {
          method: 'POST',
          body: JSON.stringify({ key: KEY, category: 'activeTopic', content: t2.text, extra: { pendingQuestion: t2.pendingQuestion, participants: t2.participants } }),
        });
      }
      for (const t2 of mem.pendingThoughts || []) {
        await api('/api/socialV2/memory-append', { method: 'POST', body: JSON.stringify({ key: KEY, category: 'pendingThought', content: t2.text }) });
      }
      for (const [target, im] of Object.entries(mem.memberImpressions || {})) {
        for (const trait of im.traits || []) {
          await api('/api/socialV2/memory-append', { method: 'POST', body: JSON.stringify({ key: KEY, category: 'memberImpression', content: trait, extra: { target } }) });
        }
      }
      for (const f of mem.facts || []) {
        const content = typeof f === 'string' ? f : (f && f.text);
        if (!content) continue;
        await api('/api/socialV2/memory-append', { method: 'POST', body: JSON.stringify({ key: KEY, category: 'fact', content }) });
      }
      log('已从快照恢复（原始 ' + ((mem.facts || []).length) + ' 条事实 / ' + ((mem.activeTopics || []).length) + ' 个话题）');
      return;
    }
    log('写回校验通过：' + summary);
    return;
  }
  log('已整理：', summary);
}

await main();
