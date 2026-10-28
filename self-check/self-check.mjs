#!/usr/bin/env node
/**
 * self-check —— 每天自查 + 自动修能修的毛病。
 *
 * 这套东西的毛病有一个共同特征：**坏了但看不出来**。
 *   · 环境变量里躺着一个失效 key → 余额告警/日报/联网搜索全静默失败
 *   · 锁被 pid 复用 → worker 每 5 秒重启一次，日志只写 code=0，看着像正常退出
 *   · 记忆的五个环节漏一个 → 平时没事，换会话或断电时才丢
 * 所以这里不做「能跑就行」的检查，专门盯这几种静默故障。
 *
 * 用法：node self-check.mjs [--fix]
 *   --fix  能自动修的自动修（清僵尸锁），修不了只报警
 * 退出码：0 全好；1 有问题
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');
const STATE = path.join(BRIDGE, 'state');
const ARCHIVE = path.join(ROOT, 'archive', 'logs');
const KEY = process.env.CHAT_KEY || 'private:YOUR_QQ';
const FIX = process.argv.includes('--fix');
const STALE_MS = 90 * 1000;

let problems = 0;
const say = (ok, msg) => { console.log((ok ? '  [OK]   ' : '  [问题] ') + msg); if (!ok) problems++; };
const fixed = (msg) => console.log('  [已修] ' + msg);

function token() {
  try { return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim(); } catch { return ''; }
}
async function api(pathname) {
  try {
    const r = await fetch(`http://127.0.0.1:3100${pathname}`, {
      headers: { 'x-console-token': token() },
      signal: AbortSignal.timeout(15000),
    });
    return await r.json();
  } catch { return {}; }
}

// ── 1) API key：环境变量 vs 文件 ─────────────────────────────────
function checkKey() {
  console.log('\n=== API Key ===');
  let fileKey = '';
  try {
    const t = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    fileKey = (t.match(/DEEPSEEK_API_KEY:\s*(sk-[A-Za-z0-9_-]+)/) || [])[1] || '';
  } catch {}
  const envKey = String(process.env.DEEPSEEK_API_KEY || '').trim();

  say(!!fileKey, `文件里的 key：${fileKey ? fileKey.slice(0, 12) + '...' : '（读不到）'}`);

  if (envKey && fileKey && envKey !== fileKey) {
    say(false, `环境变量里的 key 与文件不一致（${envKey.slice(0, 12)}...）—— 它曾让余额/日报/搜索静默 401`);
    console.log('         脚本已改成文件优先，但仍建议手动删掉这个环境变量');
  } else if (envKey) {
    say(true, '环境变量与文件一致');
  } else {
    say(true, '没有冲突的环境变量');
  }
}

// ── 2) worker 是否在反复重启 ─────────────────────────────────────
function checkRestartLoop() {
  console.log('\n=== Worker 稳定性 ===');
  const logPath = path.join(STATE, 'supervisor.log');
  let lines = [];
  try { lines = fs.readFileSync(logPath, 'utf8').split('\n').slice(-150).filter(Boolean); } catch {}

  const now = Date.now();
  let exits = 0;
  const names = new Set();
  for (const l of lines) {
    const m = l.match(/^\[([^\]]+)\]\s+(\w+)\s+退出/);
    if (!m) continue;
    const t = Date.parse(m[1].replace(/\//g, '-'));
    // 只看最近 3 分钟：更早的退出可能是已经修好的历史残留，报出来是假警报
    if (Number.isFinite(t) && now - t < 3 * 60 * 1000) { exits++; names.add(m[2]); }
  }
  say(exits < 5, exits === 0 ? '最近 3 分钟没有异常退出' : `最近 3 分钟退出 ${exits} 次（${[...names].join(',')}）—— 疑似重启循环`);

  let locks = [];
  try {
    locks = fs.readdirSync(STATE).filter((f) => f.endsWith('.lock') && f !== 'bridge.lock' && f !== 'supervisor.lock');
  } catch {}
  const stale = [];
  for (const f of locks) {
    let age = Infinity;
    try { age = Date.now() - fs.statSync(path.join(STATE, f)).mtimeMs; } catch {}
    if (age > STALE_MS) stale.push(f.replace('.lock', ''));
  }
  if (stale.length) {
    say(false, `这些 worker 的锁超过 90 秒没刷新：${stale.join(', ')}`);
    if (FIX) {
      for (const n of stale) {
        try { fs.unlinkSync(path.join(STATE, `${n}.lock`)); fixed(`清掉僵尸锁 ${n}.lock`); } catch (e) { console.log('       清理失败:', e.message); }
      }
    }
  } else {
    say(true, `${locks.length} 个 worker 锁都在心跳`);
  }
}

// ── 3) 记忆一致性 ────────────────────────────────────────────────
async function checkMemory() {
  console.log('\n=== 记忆一致性 ===');

  let fileFacts = [];
  try {
    const s = JSON.parse(fs.readFileSync(path.join(STATE, 'social-v2.json'), 'utf8'));
    fileFacts = ((s.conversations || {})[KEY] || {}).facts || [];
  } catch { say(false, '读不到 social-v2.json'); return; }
  say(true, `文件里的长期事实：${fileFacts.length} 条`);
  say(!fileFacts.some((f) => String(f.text) === '[object Object]'), '没有 [object Object] 脏数据');

  const pr = await api(`/api/socialV2/prompt?key=${encodeURIComponent(KEY)}`);
  const mem = String(pr.memory || '');
  say(fileFacts.length === 0 || mem.includes('【长期事实】'), '提示词里包含【长期事实】段');

  const raw = await api(`/api/socialV2/memory?key=${encodeURIComponent(KEY)}`);
  const apiCount = (raw.raw?.facts || []).length;
  say(apiCount === fileFacts.length, `API 读回 ${apiCount} 条，与文件一致`);

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  say(fs.existsSync(path.join(ARCHIVE, `${today}.md`)), `今天（${today}）的聊天档案存在`);
}

// ── 3.5) 档案是不是只记了一方 ──────────────────────────────────────
// 2026-10-28 发现的坑：collector 的「老游标兜底」把所有带 seq 的消息永久跳过，
// 而带 seq 的恰好都是哥发的 —— 结果两天的档案里只有她自己的话。
// 症状不明显：档案文件存在、行数在涨、self-check 的「档案存在」也照样通过。
// 所以这里专门对一次：今天聊了十几条，却一句都没有哥的，那一定是坏了。
async function checkArchiveBothSides() {
  console.log('\n=== 档案完整性 ===');
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const f = path.join(ARCHIVE, `${day}.md`);
  if (!fs.existsSync(f)) { say(false, '今天的档案文件不存在'); return; }

  // 机器人自己的昵称：优先进程问 NapCat，问不到就用档案里出现最多的那个
  let botNick = '';
  try {
    const r = await fetch('http://127.0.0.1:3000/get_login_info', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    botNick = String(j?.data?.nickname || '');
  } catch {}

  const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => /^-\s*\d{2}:\d{2}\s+\*\*/.test(l));
  const nicks = new Map();
  for (const l of lines) {
    const m = l.match(/^-\s*\d{2}:\d{2}\s+\*\*(.+?)\*\*/);
    if (m) nicks.set(m[1], (nicks.get(m[1]) || 0) + 1);
  }
  if (!botNick && nicks.size) {
    botNick = [...nicks.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  const ownerLines = lines.filter((l) => {
    const m = l.match(/^-\s*\d{2}:\d{2}\s+\*\*(.+?)\*\*/);
    return m && m[1] !== botNick;
  }).length;

  const hour = Number(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 2));
  if (lines.length >= 8 && ownerLines === 0 && hour >= 9) {
    say(false, `今天归档了 ${lines.length} 条，但一句都没有对方说的（只剩 "${botNick}" 一方）— 档案收集器又只记一方了`);
  } else {
    say(true, `档案双向正常（对方 ${ownerLines} 条 / 共 ${lines.length} 条）`);
  }
}
// ── 4) 出戏检测 ──────────────────────────────────────────────────
// 只查「角色卡最后一次改完之后」的聊天。
// 不然改了角色卡也永远在报旧账：2026-10-27 早上 07:19 那句「我是哥的 AI <BOT_NAME>」
// 是改之前的，每天都会把这条历史拉出来报警，久了就没人看这个检查了。
function roleCardMtime() {
  const dir = path.join(BRIDGE, 'roles');
  let max = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f.includes('.bak')) continue;
      const t = fs.statSync(path.join(dir, f)).mtimeMs;
      if (t > max) max = t;
    }
  } catch {}
  return max;
}

function checkRoleBreak() {
  const since = roleCardMtime();
  const sinceText = since ? new Date(since).toLocaleString('zh-CN', { hour12: false }) : '（读不到角色卡时间）';
  console.log(`\n=== 出戏检测（最近 3 天，只看角色卡改动 ${sinceText} 之后的） ===`);
  // 注意别写死成「我是AI」：她实际说的是「我是哥的 AI <BOT_NAME>」，
  // 中间夹着字，简单正则抓不到，会漏报。
  const bad = /我是[^，。！？\n]{0,8}AI|作为[^，。！？\n]{0,6}AI|我是(个)?(程序|模型|机器人)|我毕竟是\s*AI/i;
  let hits = 0;
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.now() - i * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const f = path.join(ARCHIVE, `${d}.md`);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('**<BOT_NAME>**')) continue;
      const m = line.match(/^-\s*(\d{1,2}):(\d{2})/);
      if (m && since) {
        const ts = new Date(`${d}T${String(m[1]).padStart(2, '0')}:${m[2]}:00+08:00`).getTime();
        if (Number.isFinite(ts) && ts < since) continue; // 角色卡改之前的历史，不算
      }
      if (bad.test(line)) { console.log('    ' + line.slice(0, 90)); hits++; }
    }
  }
  say(hits === 0, hits === 0 ? '没有主动提 AI 身份' : `发现 ${hits} 处，考虑加强角色卡`);
}

console.log(`=== self-check ${FIX ? '(--fix)' : ''} ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} ===`);
checkKey();
checkRestartLoop();
await checkMemory();
await checkArchiveBothSides();
checkRoleBreak();

console.log('\n' + (problems === 0 ? '全部正常' : `发现 ${problems} 个问题`));
process.exit(problems === 0 ? 0 : 1);
