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

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');
const STATE = path.join(BRIDGE, 'state');
const KEY = process.env.CHAT_KEY || 'private:YOUR_QQ';
const DRY = process.argv.includes('--dry') || process.env.DRY_RUN === '1';

const MAX_TRAITS = Number(process.env.MAX_TRAITS || 10);
const MAX_TRAIT_CHARS = Number(process.env.MAX_TRAIT_CHARS || 180);
const MAX_TOPICS = Number(process.env.MAX_TOPICS || 12);
const TOPIC_TTL_DAYS = Number(process.env.TOPIC_TTL_DAYS || 14);

function log(...a) {
  const line = `[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(STATE, 'memory-tidy.log'), line + '\n'); } catch {}
}

function token() {
  return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
}

async function api(p, options = {}) {
  const r = await fetch(`http://127.0.0.1:3100${p}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-console-token': token() },
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
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
  }).sort((a, b) => Number(b.lastMentionAt || 0) - Number(a.lastMentionAt || 0)).slice(0, MAX_TOPICS);

  const impressions = {};
  for (const [target, im] of Object.entries(mem.memberImpressions || {})) {
    const traits = dedupeList(im.traits || [], MAX_TRAITS, MAX_TRAIT_CHARS);
    impressions[target] = { traits, interactionCount: im.interactionCount || 0, lastSeenAt: im.lastSeenAt || 0 };
  }

  const thoughts = dedupeList((mem.pendingThoughts || []).map((t) => t.text), 5, 120);

  const before = JSON.stringify(mem);
  const after = JSON.stringify({ topics, impressions, thoughts });
  if (before === after) { log('记忆已经是最优状态，无需改动'); return; }

  const summary = `话题 ${(mem.activeTopics || []).length}→${topics.length}｜印象 ${Object.keys(mem.memberImpressions || {}).length}→${Object.keys(impressions).length} 人｜想法 ${(mem.pendingThoughts || []).length}→${thoughts.length}`;
  if (DRY) { log('[dry-run]', summary); return; }

  // 分类别清空，别碰 fact —— 长期事实是只增不删的，清掉就真没了
  for (const cat of ['activeTopic', 'pendingThought', 'memberImpression']) {
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
  log('已整理：', summary);
}

await main();
