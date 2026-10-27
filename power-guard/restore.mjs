#!/usr/bin/env node
/**
 * restore —— 开机后检查记忆是否丢了，丢了就从热快照恢复
 *
 * 场景：断电/强杀导致记忆没写回桥接状态时，用 chat-memory/live.json 救回来。
 * 只在「记忆为空 + 快照是 24 小时内」时恢复，避免覆盖新记忆。
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');
const STATE = path.join(BRIDGE, 'state');
const MEMDIR = path.join(ROOT, 'chat-memory');
const KEY = process.env.CHAT_KEY || 'private:YOUR_QQ';

function log(...a) {
  const line = `[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(STATE, 'restore.log'), line + '\n'); } catch {}
}

function token() {
  return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
}

async function api(p, options = {}) {
  const r = await fetch(`http://127.0.0.1:3100${p}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-console-token': token() },
    signal: AbortSignal.timeout(15000),
  });
  return r.json().catch(() => ({}));
}

async function waitBridge(seconds = 120) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    try {
      const r = await api('/api/sessions');
      if (r) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

async function main() {
  const snapFile = path.join(MEMDIR, 'live.json');
  if (!fs.existsSync(snapFile)) { log('没有热快照，跳过'); return; }
  const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  const ageH = (Date.now() - Date.parse(snap.at)) / 3600000;
  if (ageH > 24) { log(`快照太旧（${ageH.toFixed(1)}h），跳过`); return; }

  if (!(await waitBridge())) { log('桥接没起来，跳过恢复'); return; }

  const cur = await api(`/api/socialV2/memory?key=${encodeURIComponent(KEY)}`);
  const raw = cur.raw || {};
  const n = (raw.activeTopics || []).length + Object.keys(raw.memberImpressions || {}).length
    + (raw.pendingThoughts || []).length + (raw.facts || []).length;
  if (n > 0) { log(`当前记忆已有 ${n} 条，不覆盖`); return; }

  const src = snap.raw || {};
  let restored = 0;
  for (const t of src.activeTopics || []) {
    await api('/api/socialV2/memory-append', { method: 'POST', body: JSON.stringify({ key: KEY, category: 'activeTopic', content: t.text, extra: { pendingQuestion: t.pendingQuestion, participants: t.participants } }) });
    restored += 1;
  }
  for (const t of src.pendingThoughts || []) {
    await api('/api/socialV2/memory-append', { method: 'POST', body: JSON.stringify({ key: KEY, category: 'pendingThought', content: t.text }) });
    restored += 1;
  }
  for (const [target, im] of Object.entries(src.memberImpressions || {})) {
    for (const trait of im.traits || []) {
      await api('/api/socialV2/memory-append', { method: 'POST', body: JSON.stringify({ key: KEY, category: 'memberImpression', content: trait, extra: { target } }) });
      restored += 1;
    }
  }
  // 长期事实也要一起救回来，否则断电恢复后「用户几点睡」就没了
  for (const f of src.facts || []) {
    const content = typeof f === 'string' ? f : (f?.text || '');
    if (!content) continue;
    await api('/api/socialV2/memory-append', { method: 'POST', body: JSON.stringify({ key: KEY, category: 'fact', content }) });
    restored += 1;
  }
  log(`已从热快照恢复 ${restored} 条记忆（快照 ${ageH.toFixed(1)}h 前）`);
}

await main();
