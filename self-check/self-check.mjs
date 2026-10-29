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
import { execFileSync } from 'node:child_process';
import { ROOT, BRIDGE, STATE, stamp, today, chatKey, consoleToken as token } from '../lib/base.mjs';
import { DEBT_MAX_CHARS, debtParse, isDebt, memoryChars, scanMemory } from '../lib/memory-rules.mjs';
import { WORKER_NAMES } from '../supervisor/workers.mjs';

async function api(pathname) {
  try {
    const r = await fetch(`http://127.0.0.1:3100${pathname}`, {
      headers: { 'x-console-token': token() },
      signal: AbortSignal.timeout(15000),
    });
    return await r.json();
  } catch { return {}; }
}

const ARCHIVE = path.join(ROOT, 'archive', 'logs');
const KEY = chatKey();
const FIX = process.argv.includes('--fix');
const STALE_MS = 90 * 1000;

let problems = 0;
const say = (ok, msg) => { console.log((ok ? '  [OK]   ' : '  [问题] ') + msg); if (!ok) problems++; };
const fixed = (msg) => console.log('  [已修] ' + msg);

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
  say(exits < 5, exits === 0 ? '最近 3 分钟没有异常退出' : `最近 3 分钟退出 ${exits} 次（${[...names].join(',')}）${exits >= 5 ? '—— 疑似重启循环' : '（改代码触发的热重载也算，次数少就没事）'}`);

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

  // 名单上有的、但根本没在跑（连锁都没有）——这个最阴：
  // 2026-10-28 加了 peak-watch，supervisor 没重读名单，它一直不存在，
  // 但「锁都在心跳」照样显示绿。
  const running = new Set(locks.map((f) => f.replace('.lock', '')));
  const missing = WORKER_NAMES.filter((n) => !running.has(n));
  say(missing.length === 0, missing.length ? `这些 worker 名单上有、但没在跑：${missing.join(', ')}` : `名单上 ${WORKER_NAMES.length} 个 worker 全在跑`);
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

  // ── 记忆质量：有没有垃圾 / 体积有没有失控 / 数量有没有一夜暴跌 ──────
  const memRaw = raw.raw || {};
  const junk = scanMemory(memRaw);
  say(junk.length === 0, junk.length ? `记忆里有 ${junk.length} 条没用的：${junk.slice(0, 3).map((j) => j.cat + '/' + j.reason).join('，')}` : '记忆里没有垃圾条目');

  const chars = memoryChars(memRaw);
  // 上限 = 各类上限加起来的天花板（facts 2200 + 话题 12×80 + 印象 10×120 + 想法 5×120 ≈ 5000）
  // 平时只有几百字，这里防的是「某类失控长成一大坨」
  const budget = Number(process.env.MEMORY_BUDGET_CHARS || 5500);
  say(chars <= budget, `记忆体积 ${chars} 字（预算 ${budget}）`);

  // ── 欠账本：格式能拆、不超 60 字、不吃普通事实的预算 ──────────────
  // 2026-10-29 起因：鸭腿债被摘要压成一坨（「十根…两只…打五折」），谁也说不清欠多少。
  // 现在欠账走固定格式，这里盯三件事：还能不能拆、会不会超长被桥接截断、有没有超账本预算。
  const factTexts = (memRaw.facts || [])
    .map((f) => (typeof f === 'string' ? f : f && f.text))
    .filter(Boolean)
    .map(String);
  const debts = factTexts.filter((t) => isDebt(t));
  const badDebts = debts.filter((t) => !debtParse(t) || t.length > DEBT_MAX_CHARS);
  say(
    badDebts.length === 0,
    badDebts.length
      ? `有 ${badDebts.length} 条欠账格式坏了（缺日期或超 ${DEBT_MAX_CHARS} 字，将来对不了账）：${badDebts.slice(0, 2).join('；')}`
      : `欠账 ${debts.length} 条，格式都能对账`,
  );
  const debtChars = debts.reduce((a, s) => a + s.length, 0);
  const debtBudget = Number(process.env.DEBT_BUDGET_CHARS || 600);
  say(debtChars <= debtBudget, `账本 ${debtChars} 字（预算 ${debtBudget}）`);
  say(!junk.some((j) => j.cat === 'fact' && isDebt(j.text)), '欠账没有被当成垃圾条目');
  say(!debts.length || mem.includes('【欠账'), '提示词里包含【欠账】段（唤醒时能翻账）');

  try {
    const st = JSON.parse(fs.readFileSync(path.join(STATE, 'memory-stats.json'), 'utf8'));
    const prev = Number(st.facts || 0);
    const now = apiCount;
    // 一次整理正常只会少几条；少掉三成以上多半是出事了（写丢、被清空）
    const dropped = prev - now;
    say(prev === 0 || dropped <= Math.max(2, Math.floor(prev * 0.3)), `长期事实 ${prev} → ${now}（没异常暴跌）`);
    say(st.chars === undefined || Number(st.chars) <= budget * 1.5, `上次整理记录 ${st.facts} 条 / ${st.chars ?? '?'} 字`);
    // 账本不能成批消失：结清一笔是正常的，一次少三笔以上多半是写丢了
    const prevDebts = Number(st.debts || 0);
    say(prevDebts === 0 || prevDebts - debts.length <= 2, `账本 ${prevDebts} → ${debts.length} 笔（没成批消失）`);
  } catch {
    // 还没有记录（新部署），不算问题
  }
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

/**
 * 电源：笔记本一睡，网络就挂起，QQ 必掉。
 * 2026-10-29 实测：00:40 进 Modern Standby，08:36 才醒，中间她一直离线，
 * 醒来后密码登录还要短信验证 —— 一次睡眠换来一早上不说话。
 */
function checkPower() {
  console.log('\n=== 电源 / 睡眠 ===');
  const read = (sub, setting) => {
    try {
      const out = execFileSync('powercfg', ['/query', 'SCHEME_CURRENT', sub, setting], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      // 输出是本地化的（中文系统里是“当前交流/直流电源设置索引”），
      // 而且 Node 读出来可能带乱码 —— 不认文字，只按顺序取两个十六进制值：先交流、后直流。
      const hexes = [...out.matchAll(/0x([0-9a-fA-F]+)/g)].map((m) => parseInt(m[1], 16));
      return { ac: hexes[0] ?? -1, dc: hexes[1] ?? -1 };
    } catch {
      return { ac: -1, dc: -1 };
    }
  };
  const never = (v) => v === 0 || v === 0xffffffff; // 0 和 0xFFFFFFFF 都表示「永不」
  const sleep = read('SUB_SLEEP', 'STANDBYIDLE');
  say(never(sleep.ac) && never(sleep.dc), `睡眠超时 交流=${sleep.ac === 0xffffffff ? '永不' : sleep.ac + 's'} 电池=${sleep.dc === 0xffffffff ? '永不' : sleep.dc + 's'}`);

  const video = read('SUB_VIDEO', 'VIDEOIDLE');
  say(never(video.ac), `熄屏超时 交流=${video.ac === 0xffffffff ? '永不' : video.ac + 's'}（熄屏会进 Modern Standby 断网）`);

  // 自启里有没有「保持唤醒」，没有的话睡眠照样会把她带走
  let awake = false;
  try {
    const run = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'QQKeepAwake'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    awake = /QQKeepAwake/i.test(run);
  } catch {}
  if (!awake) {
    try {
      const dir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
      awake = fs.readdirSync(dir).some((f) => /keepawake/i.test(f));
    } catch {}
  }
  say(awake, awake ? '开机自启里有「保持唤醒」' : '没有「保持唤醒」自启项：电脑空闲睡眠时她会掉线');

  // 自启项只保证「开机时有」；进程中途死掉没人知道。
  // 2026-10-29 就是这样：进程悄悄没了，中午合盖机器自己睡，QQ 一掉 10 小时。
  // 4-hold-awake.ps1 每 30 秒写一次心跳，巡检也按它判活并重拉。
  const beat = path.join(ROOT, 'state', 'keep-awake.heartbeat');
  let beatAge = Infinity;
  try { beatAge = Date.now() - fs.statSync(beat).mtimeMs; } catch {}
  const alive = beatAge < 3 * 60 * 1000;
  say(alive, alive ? `保持唤醒进程还活着（心跳 ${Math.round(beatAge / 1000)} 秒前）` : `保持唤醒没心跳（${Number.isFinite(beatAge) ? Math.round(beatAge / 60000) + ' 分钟前' : '文件不存在'}）：机器随时可能自己睡，巡检会重拉`);

  // 进过 Modern Standby 就会断网，QQ 跟着掉。合盖动作/熄屏超时都已经设成 0，
  // 但 OEM 固件仍可能自己进待机 —— 所以直接看事件日志，进了就报出来。
  let standby = 0;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; StartTime=(Get-Date).AddHours(-24)} -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq 506 } | Measure-Object).Count",
    ], { encoding: 'utf8', windowsHide: true, timeout: 25000 });
    standby = Number(String(out || '').trim() || 0);
  } catch {}
  say(standby === 0, standby ? `最近 24 小时进过 ${standby} 次 Modern Standby（每次都可能断网掉线）` : '最近 24 小时没进过 Modern Standby');
}

console.log(`=== self-check ${FIX ? '(--fix)' : ''} ${stamp()} ===`);
checkKey();
checkRestartLoop();
checkPower();
await checkMemory();
await checkArchiveBothSides();
checkRoleBreak();

console.log('\n' + (problems === 0 ? '全部正常' : `发现 ${problems} 个问题`));
process.exit(problems === 0 ? 0 : 1);
