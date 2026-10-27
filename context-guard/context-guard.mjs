#!/usr/bin/env node
import { singleInstance } from '../lock/single.mjs';
singleInstance('context');
/**
 * context-guard —— 把上下文摁在低位，让她能聊一整天还不贵
 *
 * 原理：token 花费 ≈ 上下文长度 × 请求次数。会话越聊越长，每条消息都要重发整段历史。
 * 做法：平均上下文超过阈值时，把会话换新，但**先保存记忆和最近几句对话**再恢复：
 *   1. 读 memory（话题/想法/印象）
 *   2. 读最近 8 条消息，压成一段「你们刚才在聊」
 *   3. 重置会话（上下文归零）
 *   4. 把那段话写成新会话的初始提示词 + 恢复记忆
 *
 * 环境变量：ROTATE_AT（默认 30000）、CHECK_MIN（默认 10）、IDLE_MIN（默认 5）、COOLDOWN_MIN（默认 90）
 *          DRY_RUN=1 只打印不执行
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BRIDGE = path.join(HERE, '..', 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');
const STATE = path.join(BRIDGE, 'state');
const KEY = process.env.CHAT_KEY || 'private:YOUR_QQ';
const ROTATE_AT = Number(process.env.ROTATE_AT || 32000);
const URGENT_AT = Number(process.env.URGENT_AT || 52000);
// 硬上限：到了这个长度就不再管回合忙不忙，直接换。
// 有记忆快照 + 回顾兜底，换掉不会失忆，比继续按 60k 烧着划算。
const CRITICAL_AT = Number(process.env.CRITICAL_AT || 65000);
const CHECK_MIN = Math.max(2, Number(process.env.CHECK_MIN || 3));
const IDLE_MIN = Number(process.env.IDLE_MIN || 1);
const COOLDOWN_MIN = Number(process.env.COOLDOWN_MIN || 90);
const DRY = process.env.DRY_RUN === '1';

const MARK = path.join(STATE, 'context-guard.json');

function log(...a) {
  const line = `[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(STATE, 'context-guard.log'), line + '\n'); } catch {}
}

function token() {
  return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
}

async function api(pathname, options = {}) {
  const r = await fetch(`http://127.0.0.1:3100${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-console-token': token() },
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
}

function avgContext(n = 20, since = 0) {
  const file = path.join(STATE, 'token-usage.jsonl');
  let rows = [];
  try {
    rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-800)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.k === 'turn' && (!since || r.t > since));
  } catch { return 0; }
  const last = rows.slice(-n);
  if (!last.length) return 0;
  const sum = last.reduce((acc, r) => acc + (r.b?.cacheHit || 0) + (r.b?.cacheMiss || 0), 0);
  return sum / last.length;
}

function lastApiAt() {
  // \u6700\u540e\u4e00\u6b21\u771f\u5b9e API \u8c03\u7528\u65f6\u95f4\uff1a\u6bd4 lastActionAt \u66f4\u51c6\u786e\u5730\u5224\u65ad\u56de\u5408\u662f\u5426\u7ed3\u675f
  try {
    const lines = fs.readFileSync(path.join(STATE, "token-usage.jsonl"), "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    return Number(last.t || 0);
  } catch { return 0; }
}

function lastActionAt() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(STATE, 'social-v2.json'), 'utf8'));
    const c = (s.conversations || {})[KEY] || {};
    return Number(c.lastActionAt || c.lastIncomingAt || c.lastAiReplyAt || 0);
  } catch { return 0; }
}

function readMark() {
  try { return JSON.parse(fs.readFileSync(MARK, 'utf8')); } catch { return {}; }
}
function writeMark(v) {
  try { fs.writeFileSync(MARK, JSON.stringify(v, null, 2)); } catch {}
}

function snapshotMemory(mem) {
  try {
    const dir = path.join(HERE, '..', 'chat-memory');
    fs.mkdirSync(dir, { recursive: true });
    const name = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) + '.json';
    const file = path.join(dir, name);
    const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    prev[KEY] = { savedAt: new Date().toISOString(), memory: mem };
    fs.writeFileSync(file, JSON.stringify(prev, null, 2));
    return file;
  } catch (e) { log('记忆快照失败:', e.message); return null; }
}

async function rotate() {
  const mem = (await api(`/api/socialV2/memory?key=${encodeURIComponent(KEY)}`)).body?.raw || {};
  const recent = (await api(`/api/socialV2/recent?key=${encodeURIComponent(KEY)}&limit=25`)).body?.messages || [];

  const lines = recent
    .filter((m) => m && (m.plain || m.text))
    .map((m) => `${m.isSelf ? '我' : '对方'}：${String(m.plain || m.text).replace(/\s+/g, ' ').slice(0, 80)}`)
    .slice(-20);
  const recap = lines.length
    ? [
        '你们刚才在聊（换个新会话继续，别提「换会话」这件事）：',
        ...lines,
        '',
        '开工前先做一件事：把上面这些内容里**值得长期记住的事**（用户的偏好、正在忙的事、答应过的事、重要的人和日期）',
        '用 qq_memory_append 记 1~3 条（memberImpression / activeTopic），记完再接着聊。不要向用户复述你在记什么。',
      ].join('\n')
    : '';

  const snap = snapshotMemory(mem);
  if (snap) log('记忆已快照 ->', snap);

  const reset = await api('/api/session/reset', { method: 'POST', body: JSON.stringify({ key: KEY }) });
  if (!reset.body?.ok) {
    log('重置失败:', JSON.stringify(reset.body).slice(0, 160));
    return false;
  }

  if (recap) {
    const iv = await api('/api/socialV2/initial-prompt', {
      method: 'POST',
      body: JSON.stringify({ key: KEY, text: recap.slice(0, 3200) }),
    });
    if (!iv.body?.ok) log('初始提示词写入失败:', JSON.stringify(iv.body).slice(0, 120));
  }

  let restored = 0;
  for (const t of mem.activeTopics || []) {
    const r = await api('/api/socialV2/memory-append', {
      method: 'POST',
      body: JSON.stringify({ key: KEY, category: 'activeTopic', content: t.text, extra: { pendingQuestion: t.pendingQuestion, participants: t.participants } }),
    });
    if (r.body?.ok) restored += 1;
  }
  for (const t of mem.pendingThoughts || []) {
    const r = await api('/api/socialV2/memory-append', {
      method: 'POST',
      body: JSON.stringify({ key: KEY, category: 'pendingThought', content: t.text, extra: { motivation: t.motivation } }),
    });
    if (r.body?.ok) restored += 1;
  }
  for (const [target, im] of Object.entries(mem.memberImpressions || {})) {
    const r = await api('/api/socialV2/memory-append', {
      method: 'POST',
      body: JSON.stringify({ key: KEY, category: 'memberImpression', content: im.text || im.note || String(im), extra: { target } }),
    });
    if (r.body?.ok) restored += 1;
  }
  // 长期事实：session/reset 会把会话状态整个清空，这里必须补回去，否则一换会话就丢
  for (const f of mem.facts || []) {
    const content = typeof f === 'string' ? f : (f?.text || '');
    if (!content) continue;
    const r = await api('/api/socialV2/memory-append', {
      method: 'POST',
      body: JSON.stringify({ key: KEY, category: 'fact', content }),
    });
    if (r.body?.ok) restored += 1;
  }

  const expect = (mem.activeTopics || []).length + (mem.pendingThoughts || []).length
    + Object.keys(mem.memberImpressions || {}).length + (mem.facts || []).length;
  if (expect > 0 && restored === 0) {
    log(`⚠️ 记忆恢复 0 条（应有 ${expect} 条），快照在 ${snap || '（快照失败）'}`);
  } else {
    log(`已换新会话：记忆恢复 ${restored}/${expect} 条，回顾 ${lines.length} 句`);
  }
  return true;
}

async function tick() {
  const mark = readMark();
  // 没有活跃会话（刚换过、还没来消息）就什么都不做
  const sessions = await api('/api/sessions').catch(() => ({ body: {} }));
  const list = Array.isArray(sessions.body) ? sessions.body : (sessions.body?.sessions || []);
  if (!list.length) return;

  const ctx = avgContext(20, mark.lastRotateAt || 0);
  if (ctx < ROTATE_AT) return;

  const critical = ctx >= CRITICAL_AT;
  const urgent = ctx >= URGENT_AT;
  const sinceApi = Date.now() - lastApiAt();
  const quietMs = critical ? 0 : (urgent ? 30000 : IDLE_MIN * 60000);
  if (!critical && lastApiAt() && sinceApi < quietMs) {
    log(`上下文 ${Math.round(ctx)}${critical ? " 🔴已过硬上限" : (urgent ? " ⚠️已过紧急线" : "")}，回合还在跑（${Math.round(sinceApi / 1000)}s 前还有调用），等它结束`);
    return;
  }
  // 冷却期：原来一律 90 分钟，结果 60k 上下文能被"冷却"钉在原地烧半小时。
  // 现在硬上限不等，紧急线只等 5 分钟，普通情况仍按 COOLDOWN_MIN。
  const cooldownMin = critical ? 0 : (urgent ? 5 : COOLDOWN_MIN);
  if (cooldownMin > 0 && mark.lastRotateAt && Date.now() - mark.lastRotateAt < cooldownMin * 60000) return;

  log(`平均上下文 ${Math.round(ctx)} > ${ROTATE_AT}，准备换新会话（先存记忆和最近对话）`);
  if (DRY) { log('[dry-run] 不执行'); return; }
  const ok = await rotate();
  if (ok) writeMark({ lastRotateAt: Date.now(), lastCtx: Math.round(ctx) });
}

log(`上下文守门员启动：超过 ${ROTATE_AT} 就换会话 / 每 ${CHECK_MIN} 分钟检查 / 空闲 ${IDLE_MIN} 分钟才动`);
await tick();
setInterval(() => void tick().catch((e) => log('出错:', e.message)), CHECK_MIN * 60000);
