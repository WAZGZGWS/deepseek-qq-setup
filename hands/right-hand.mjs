/**
 * 右手 —— 删无用记忆和重复记忆。只按主脑的裁决动手。
 *
 * 为什么不让小脑自己删：小脑负责「看出问题」（污染字符、重复、该留的核心要点），
 * 动手是右手的活。分开之后，删记忆这件事永远要过主脑，而且每次删什么都能查。
 *
 * 铁规矩：
 *   1. 只删「同一句话的重复」和「纯污染」；两条记忆语义相近但措辞不同，不删（可能都是要点）；
 *   2. 删之前先把整份记忆备份到 chat-memory/backup-<时间>.json；
 *   3. 走桥接的 memory-remove 接口删（bridge 内存里的状态才是准的，直接改文件会被它覆盖）；
 *   4. 一次最多删 20 条，删完立刻写进决策日志。
 */

export const INFO = { name: '右手', role: '删无用/重复记忆', version: 1 };

import fs from 'node:fs';
import path from 'node:path';

const MAX_REMOVE = 20;
const CACHE_MS = 60000;
let cache = { at: 0, raw: null };

const CATS = [
  { api: 'fact', field: 'facts', label: '长期事实' },
  { api: 'activeTopic', field: 'activeTopics', label: '进行中的话题' },
  { api: 'pendingThought', field: 'pendingThoughts', label: '想说没说的话' },
];

function readToken(bridgeDir) {
  try { return fs.readFileSync(path.join(bridgeDir, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

async function fetchMemory(ctx) {
  const now = Date.now();
  if (cache.raw && now - cache.at < CACHE_MS) return cache.raw;
  const token = readToken(ctx.bridgeDir);
  const key = ctx.key;
  if (!token || !key) return null;
  try {
    const r = await fetch(`http://127.0.0.1:3100/api/socialV2/memory?key=${encodeURIComponent(key)}`, {
      headers: { 'x-console-token': token },
      signal: AbortSignal.timeout(6000),
    });
    const j = await r.json();
    if (!j || !j.ok) return null;
    cache = { at: now, raw: j.raw || null };
    return cache.raw;
  } catch { return null; }
}

/** 归一化：去掉控制字符/零宽/标点/空白，用来判断「是不是同一句」 */
function normalize(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, '')
    .replace(/[，。！？、；：""''（）()\[\]【】…—\-\s,.!?;:'"`~]/g, '')
    .toLowerCase();
}

/** 污染：控制字符、替换符、纯标点、空 */
function polluted(s) {
  const t = String(s ?? '');
  if (!t.trim()) return '空内容';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) return '控制字符';
  if (t.includes('\uFFFD')) return '乱码（替换符）';
  if (normalize(t).length < 2) return '只剩符号/一个字';
  if (/\s{6,}/.test(t)) return '空白过多';
  return '';
}

export async function collect(ctx) {
  const raw = await fetchMemory(ctx);
  if (!raw) return { proposals: [], metrics: { available: false } };
  const items = [];
  const seen = new Map();
  const stats = { facts: (raw.facts || []).length, topics: (raw.activeTopics || []).length, dup: 0, polluted: 0 };

  for (const c of CATS) {
    const list = Array.isArray(raw[c.field]) ? raw[c.field] : [];
    for (const entry of list) {
      const text = String(entry && entry.text !== undefined ? entry.text : '');
      const why = polluted(text);
      if (why) {
        items.push({ category: c.api, content: text, why: `${c.label}：${why}` });
        stats.polluted += 1;
        continue;
      }
      const k = `${c.api}::${normalize(text)}`;
      if (seen.has(k)) {
        items.push({ category: c.api, content: text, why: `${c.label}：和上一条重复` });
        stats.dup += 1;
      } else {
        seen.set(k, text);
      }
    }
  }

  const capped = items.slice(0, MAX_REMOVE);
  if (!capped.length) return { proposals: [], metrics: { ...stats, available: true } };
  return {
    proposals: [{
      kind: 'clean-memory',
      why: `${capped.length} 条（重复 ${stats.dup} / 污染 ${stats.polluted}）`,
      items: capped,
      essential: false,
    }],
    metrics: { ...stats, available: true },
  };
}

export async function apply(ctx, items = []) {
  const token = readToken(ctx.bridgeDir);
  const key = ctx.key;
  if (!token || !key) return { ok: false, err: '没有 console-token 或 key' };

  // 备份：先落一份完整记忆，删坏了能捞
  let backedUp = '';
  try {
    const r = await fetch(`http://127.0.0.1:3100/api/socialV2/memory?key=${encodeURIComponent(key)}`, {
      headers: { 'x-console-token': token }, signal: AbortSignal.timeout(6000),
    });
    const j = await r.json();
    const dir = path.join(ctx.root, 'chat-memory');
    fs.mkdirSync(dir, { recursive: true });
    backedUp = path.join(dir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backedUp, JSON.stringify({ at: new Date().toISOString(), key, raw: j.raw }, null, 2));
  } catch {}

  let removed = 0;
  const failed = [];
  for (const it of items) {
    try {
      const r = await fetch('http://127.0.0.1:3100/api/socialV2/memory-remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': token },
        body: JSON.stringify({ key, category: it.category, content: it.content }),
        signal: AbortSignal.timeout(6000),
      });
      const j = await r.json();
      if (j && j.ok) removed += 1;
      else failed.push(it.content.slice(0, 30));
    } catch { failed.push(it.content.slice(0, 30)); }
  }
  cache = { at: 0, raw: null }; // 下次重新读
  return { ok: removed > 0, removed, failed: failed.length, backup: backedUp };
}
