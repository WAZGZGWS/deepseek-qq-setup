#!/usr/bin/env node
/**
 * brain —— 全栈主脑：一个入口管住所有后台脚本，并且**自己会拿主意**。
 *
 * 它替掉原来分散的三处职责：supervisor（拉进程）+ stack-guard（守窗口）+
 * doctor 里的「worker 锁数量」判断 —— 现在统一到这里，看状态只有一条命令。
 *
 * 为什么不是「把 9 个脚本塞进同一个进程」：
 *   9 个 worker 全是常驻定时任务，塞一个进程里的话——一个未捕获异常、一次内存泄漏、
 *   一个卡死的同步调用，就会让**全部 9 个一起死**（连巡检都没人跑）。
 *   所以主脑管的是「启动/守护/决策/状态/日志」，每个 worker 仍然独立进程跑，崩一个不连坐。
 *
 * 决策表（每一项都是真踩过才写的，不是设想）：
 *   1. worker 崩了            → 5 秒后重启；锁冲突（退出码 3）等 30 秒
 *   2. 同一个 worker 10 分钟内崩 4 次 → 隔离 10 分钟，写告警，别无限重试刷日志
 *   3. worker 活着但锁 180 秒没心跳 → 判定卡死，杀掉重启（卡在同步调用时就是这症状）
 *   4. worker 日志里 'Cannot find module' → 不重启了，标记坏依赖，隔离 30 分钟
 *   5. 缺文件                → 跳过并记一笔，不刷屏
 *   6. :3100 断、:3000 通    → 拉起桥接；15 分钟内失败 3 次就退避 10 分钟
 *   7. :3000 断              → 不硬来，交给巡检（它有登录次数预算/夜间静默那套规矩），
 *                              并确认巡检任务真的在跑（超过 10 分钟没跑就 /run 它）
 *   8. 旧 supervisor 复活    → 收掉（两边各拉一套 worker 会互相抢锁）
 *   9. 锁文件指向死进程      → 清掉
 *  10. 日志超过 8MB          → 只留最后 1500 行
 *
 * 用法：
 *   node brain.mjs            前台运行（带守护 + 决策，开机由 20-supervisor.bat 拉起）
 *   node brain.mjs --status   只看状态（谁在跑、重启几次、多久没心跳、最近决策）
 *   node brain.mjs --decisions 最近 20 条决策（排查「它为什么动了手」）
 *   node brain.mjs --once     起一遍就退（调试用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, BRIDGE, STATE, stamp, portOpen } from './lib/base.mjs';
import { singleInstance } from './lock/single.mjs';
import { WORKER_NAMES } from './supervisor/workers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRAIN_STATE = path.join(STATE, 'brain.json');
const BRAIN_LOG = path.join(STATE, 'brain.log');
const DEC_LOG = path.join(STATE, 'brain-decisions.jsonl');
const SUP_LOCK = path.join(STATE, 'supervisor.lock');
const STATUS_ONLY = process.argv.includes('--status');
const DECISIONS_ONLY = process.argv.includes('--decisions');
const ONCE = process.argv.includes('--once');

const PORTS = { napcat: 3000, bridge: 3100 };
const QUARANTINE_MS = 10 * 60 * 1000;   // 反复崩 → 隔离 10 分钟
const BROKEN_MS = 30 * 60 * 1000;       // 依赖缺失 → 隔离 30 分钟（等人工装，不自作主张 npm i）
const CRASH_WINDOW_MS = 10 * 60 * 1000; // 10 分钟内崩 4 次算「反复崩」
const CRASH_LIMIT = 4;
const HUNG_LOCK_SEC = 180;              // 锁 3 分钟不跳 = 卡死
const LOG_MAX_BYTES = 8 * 1024 * 1024;

const workers = [];   // { name, file, child, restarts, lastStart, lastExit, recentExits:[], quarantineUntil, brokenUntil, brokenWhy, restartTimer }
const decisions = []; // 内存里最近 50 条，落盘另有一份 jsonl
// 端口状态由 60 秒的 reviewStack 更新；20 秒的状态落盘要复用它，
// 否则每次写盘都会把 napcat/bridge 写成 false，状态页看起来像「全断了」。
let lastStack = { napcat: false, bridge: false };
let stopping = false;

/** 决策日志：主脑每做一次“选择”都记一笔，事后能回答「它当时为什么这么干」 */
function decide(rule, action, detail = '') {
  const rec = { at: new Date().toISOString(), rule, action, detail };
  decisions.push(rec);
  if (decisions.length > 50) decisions.shift();
  const line = `[${stamp()}] 决策 ${rule} → ${action}${detail ? '（' + detail + '）' : ''}`;
  log(line);
  try { fs.appendFileSync(DEC_LOG, JSON.stringify(rec) + '\n'); } catch {}
  return rec;
}

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  try { console.log(line); } catch {}
  try { fs.appendFileSync(BRAIN_LOG, line + '\n'); } catch {}
}

// ── 判活工具 ────────────────────────────────────────────────────────

/** worker 清单：name + 入口文件（沿用 supervisor 的注册表，避免两处名单） */
function registry() {
  const file = path.join(ROOT, 'supervisor', 'workers.mjs');
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of text.matchAll(/name:\s*'([^']+)'[\s\S]{0,200}?file:\s*path\.join\(ROOT,\s*'([^']+)',\s*'([^']+)'\)/g)) {
    out.push({ name: m[1], file: path.join(ROOT, m[2], m[3]) });
  }
  return out;
}

/** 锁文件多久没刷新（秒）——worker 每 20 秒摸一次自己的锁 */
function lockAge(name) {
  try {
    return Math.round((Date.now() - fs.statSync(path.join(STATE, `${name}.lock`)).mtimeMs) / 1000);
  } catch {
    return -1;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** 这个 pid 真的是 node 进程吗（防 Windows pid 复用杀错人） */
function isNodePid(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    return /node\.exe/i.test(out);
  } catch { return false; }
}

function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 }); return true; } catch { return false; }
}

function readPidFile(f) {
  try { return Number(fs.readFileSync(f, 'utf8').trim()) || 0; } catch { return 0; }
}

function tail(file, lines = 40) {
  try {
    const buf = fs.readFileSync(file, 'utf8');
    return buf.split('\n').slice(-lines).join('\n');
  } catch { return ''; }
}

// ── 状态 ────────────────────────────────────────────────────────────

function writeStatus(extra = {}) {
  const now = Date.now();
  const rows = workers.map((w) => ({
    name: w.name,
    pid: w.child && w.child.pid ? w.child.pid : 0,
    alive: !!(w.child && w.child.exitCode === null),
    restarts: w.restarts,
    uptimeSec: w.lastStart ? Math.round((now - w.lastStart) / 1000) : 0,
    lockAgeSec: lockAge(w.name),
    quarantineSec: w.quarantineUntil > now ? Math.round((w.quarantineUntil - now) / 1000) : 0,
    broken: w.brokenUntil > now ? w.brokenWhy || '坏依赖' : '',
  }));
  const data = {
    at: new Date().toISOString(),
    pid: process.pid,
    workers: rows,
    missing: WORKER_NAMES.filter((n) => !rows.some((r) => r.name === n)),
    bridge: !!(extra.bridge !== undefined ? extra.bridge : lastStack.bridge),
    napcat: !!(extra.napcat !== undefined ? extra.napcat : lastStack.napcat),
    recentDecisions: decisions.slice(-5),
    ...extra,
  };
  try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(BRAIN_STATE, JSON.stringify(data, null, 2)); } catch {}
  return data;
}

function printStatus() {
  const d = (() => { try { return JSON.parse(fs.readFileSync(BRAIN_STATE, 'utf8')); } catch { return null; } })();
  if (!d) { console.log('还没有 brain.json（主脑还没跑过）'); return; }
  console.log(`主脑 pid=${d.pid}  更新于 ${new Date(d.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log(`  NapCat:${d.napcat ? '通' : '断'}  桥接:${d.bridge ? '通' : '断'}`);
  console.log('  名字        状态    pid      重启  锁心跳  备注');
  for (const r of d.workers) {
    const beat = r.lockAgeSec < 0 ? '无锁' : `${r.lockAgeSec}s`;
    let note = '';
    if (r.quarantineSec) note = `隔离 ${Math.ceil(r.quarantineSec / 60)} 分钟`;
    if (r.broken) note = '坏：' + r.broken;
    console.log(`  ${r.name.padEnd(10)} ${r.alive ? '在跑' : '停了'}  ${String(r.pid).padEnd(8)} ${String(r.restarts).padEnd(5)} ${beat.padEnd(6)} ${note}`);
  }
  if (d.missing && d.missing.length) console.log('  名单上缺：' + d.missing.join(','));
  if (d.recentDecisions && d.recentDecisions.length) {
    console.log('  最近决策：');
    for (const r of d.recentDecisions) {
      console.log(`    ${new Date(r.at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })} ${r.rule} → ${r.action}${r.detail ? '（' + r.detail + '）' : ''}`);
    }
  }
}

function printDecisions() {
  let lines = [];
  try { lines = fs.readFileSync(DEC_LOG, 'utf8').trim().split('\n').slice(-20); } catch {}
  if (!lines.length) { console.log('还没有决策记录'); return; }
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      console.log(`${new Date(r.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}  ${r.rule} → ${r.action}${r.detail ? '（' + r.detail + '）' : ''}`);
    } catch {}
  }
}

// ── 拉起 / 收掉 ─────────────────────────────────────────────────────

function clearRestartTimer(w) {
  if (w.restartTimer) { clearTimeout(w.restartTimer); w.restartTimer = null; }
}

function start(w) {
  if (stopping) return;
  if (!fs.existsSync(w.file)) {
    if (!w.reportedMissing) {
      decide('worker-缺文件', '跳过 ' + w.name, w.file);
      w.reportedMissing = true;
    }
    return;
  }
  const now = Date.now();
  if (w.brokenUntil > now) return;      // 坏依赖，等人工
  if (w.quarantineUntil > now) return;  // 反复崩，先冷一会儿

  const outPath = path.join(STATE, `worker-${w.name}.log`);
  let out = null;
  try { out = fs.openSync(outPath, 'a'); } catch {}
  const child = spawn(process.execPath, [w.file], {
    cwd: path.dirname(w.file),
    stdio: ['ignore', out ? out : 'ignore', out ? out : 'ignore'],
    windowsHide: true,
    env: { ...process.env, BRAIN: '1' },
  });
  w.child = child;
  w.lastStart = now;
  w.reportedMissing = false;
  log(`启动 ${w.name} pid=${child.pid}`);
  if (out) { try { fs.closeSync(out); } catch {} }

  child.on('exit', (code, signal) => {
    w.lastExit = { code, signal, at: Date.now() };
    w.recentExits.push(Date.now());
    w.recentExits = w.recentExits.filter((t) => Date.now() - t < CRASH_WINDOW_MS);
    if (stopping) return;
    w.restarts += 1;

    // 决策 4：依赖缺了，重启一百次也没用 —— 隔离，写告警，别刷日志
    const t = tail(path.join(STATE, `worker-${w.name}.log`), 60);
    const miss = t.match(/Cannot find module '([^']+)'/);
    if (miss) {
      w.brokenUntil = Date.now() + BROKEN_MS;
      w.brokenWhy = '缺模块 ' + miss[1];
      decide('worker-坏依赖', '隔离 ' + w.name + ' 30 分钟', miss[1]);
      try { fs.writeFileSync(path.join(STATE, `ALERT-worker-${w.name}.txt`), `[${stamp()}] ${w.name} 缺模块 ${miss[1]}\n装好再等主脑自动重试，或手动改掉这个 worker。\n`); } catch {}
      return;
    }

    if (code === 3) { // 锁冲突：多半是别的实例还活着，等它自己过期
      log(`${w.name} 因锁冲突退出（另一个实例在跑），30 秒后复查`);
    } else {
      log(`${w.name} 退出 code=${code} sig=${signal || ''}，5 秒后重启`);
      decide('worker-崩了', '重启 ' + w.name, `code=${code}${signal ? ' sig=' + signal : ''}，第 ${w.recentExits.length} 次`);
    }

    // 决策 2：反复崩 → 隔离，避免「重启风暴」把日志和 CPU 吃光（也避免被当成异常行为）
    if (w.recentExits.length >= CRASH_LIMIT) {
      w.quarantineUntil = Date.now() + QUARANTINE_MS;
      decide('worker-反复崩', `隔离 ${w.name} 10 分钟`, `${w.recentExits.length} 次/${CRASH_WINDOW_MS / 60000} 分钟，退出码 ${code}`);
      try { fs.writeFileSync(path.join(STATE, `ALERT-worker-${w.name}.txt`), `[${stamp()}] ${w.name} 10 分钟内崩了 ${w.recentExits.length} 次\n` + t.split('\n').slice(-8).join('\n') + '\n'); } catch {}
      return;
    }

    const delay = code === 3 ? 30000 : 5000;
    clearRestartTimer(w);
    w.restartTimer = setTimeout(() => { w.restartTimer = null; start(w); }, delay);
  });
}

function stopAll() {
  stopping = true;
  for (const w of workers) {
    clearRestartTimer(w);
    try { if (w.child && w.child.exitCode === null) w.child.kill(); } catch {}
  }
}

// ── 接管 / 抢锁 ─────────────────────────────────────────────────────

/**
 * 接管旧 supervisor（老角色，已经被主脑取代）。
 * 它也拉一整套 worker，两边抢单实例锁的典型症状是「状态表全停了、机器上却有 worker 在跑」。
 */
function takeOverSupervisor() {
  const pid = readPidFile(SUP_LOCK);
  if (!pid || pid === process.pid) return;
  if (!pidAlive(pid) || !isNodePid(pid)) { try { fs.unlinkSync(SUP_LOCK); } catch {} return; }
  if (killTree(pid)) decide('接管旧 supervisor', '收掉 pid ' + pid, '两边各拉一套 worker 会互相抢锁');
  else decide('接管旧 supervisor', '收掉失败 pid ' + pid, '它可能还在抢 worker');
}

/** 占住 supervisor 的角色锁：只要主脑活着，旧 supervisor 起来就自己退出（码 3） */
function claimSupervisorRole() {
  const beat = () => { try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(SUP_LOCK, String(process.pid)); } catch {} };
  beat();
  setInterval(beat, 20000).unref?.();
  process.on('exit', () => {
    try { if (readPidFile(SUP_LOCK) === process.pid) fs.unlinkSync(SUP_LOCK); } catch {}
  });
}

/** 锁被人占着、但那不是我的子进程 → 孤儿回收（只认 node 进程，别杀错） */
function killOrphan(name) {
  const f = path.join(STATE, `${name}.lock`);
  const pid = readPidFile(f);
  if (!pid || pid === process.pid) return;
  if (workers.some((w) => w.child && w.child.pid === pid)) return;
  if (!pidAlive(pid) || !isNodePid(pid)) { try { fs.unlinkSync(f); } catch {} return; }
  if (lockAge(name) > 90) { try { fs.unlinkSync(f); } catch {} return; }
  if (killTree(pid)) decide('worker-孤儿锁', '清掉 ' + name + ' pid ' + pid, '锁被别的进程占着');
  try { fs.unlinkSync(f); } catch {}
}

// ── 决策规则：worker 层 ─────────────────────────────────────────────

function reviewWorkers() {
  const now = Date.now();
  for (const w of workers) {
    const alive = w.child && w.child.exitCode === null;

    // 决策 3：活着但锁不跳 = 卡死（同步调用/死循环），杀掉重来
    if (alive && w.lastStart && now - w.lastStart > 240000) {
      const age = lockAge(w.name);
      if (age > HUNG_LOCK_SEC) {
        decide('worker-卡死', '重启 ' + w.name, `锁 ${age}s 没心跳`);
        try { w.child.kill(); } catch {}
        continue;
      }
    }

    if (alive) continue;
    if (w.quarantineUntil > now || w.brokenUntil > now) continue;

    // 没在跑，也没有待触发的重启定时器（定时器路径由 exit 事件负责）
    if (w.restartTimer) continue;

    killOrphan(w.name);
    const age = lockAge(w.name);
    if (age >= 0 && age < 120) continue; // 别人的实例还活着，别抢
    decide('worker-补拉', '拉起 ' + w.name, age < 0 ? '没有锁' : `锁 ${age}s 没心跳`);
    start(w);
  }
}

// ── 决策规则：桥接 / 巡检 / 磁盘 ────────────────────────────────────

let bridgeStarted = [];    // 拉起桥接的时间戳，用来退避
let bridgeBackoffUntil = 0;
let napcatDownStreak = 0;
let lastDoctorRun = 0;

function startBridge() {
  const now = Date.now();
  bridgeStarted = bridgeStarted.filter((t) => now - t < 15 * 60 * 1000);
  if (now < bridgeBackoffUntil) return false;
  if (bridgeStarted.length >= 3) {
    bridgeBackoffUntil = now + 10 * 60 * 1000;
    decide('桥接-多次拉不起来', '退避 10 分钟', `15 分钟内试了 ${bridgeStarted.length} 次`);
    try { fs.writeFileSync(path.join(STATE, 'ALERT-bridge.txt'), `[${stamp()}] 桥接 15 分钟内拉了 ${bridgeStarted.length} 次还是没起来，先歇 10 分钟再看。\n`); } catch {}
    return;
  }
  bridgeStarted.push(now);
  try {
    const out = fs.openSync(path.join(STATE, 'bridge-run.log'), 'a');
    const child = spawn(process.execPath, [path.join(BRIDGE, 'src', 'bridge.js')], {
      cwd: BRIDGE, stdio: ['ignore', out, out], windowsHide: true, detached: true,
    });
    child.unref();
    decide('桥接-断了', '拉起桥接 pid ' + child.pid, 'NapCat 通、:3100 断');
    try { fs.closeSync(out); } catch {}
    return true;
  } catch (e) {
    decide('桥接-拉起失败', '记一笔', e.message);
    return false;
  }
}

/** 巡检是登录/掉线那套规矩的负责人（次数预算、夜间静默、邮件链接都在它那儿），
 *  主脑不越权碰 QQ 登录，只负责「确认它还在跑」。 */
function ensureDoctor() {
  const now = Date.now();
  if (now - lastDoctorRun < 5 * 60 * 1000) return;
  let last = 0;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "(Get-ScheduledTaskInfo -TaskName 'QQStackDoctor').LastRunTime.ToUniversalTime().ToString('o')"],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    last = Date.parse(out.trim()) || 0;
  } catch {}
  if (last && now - last < 10 * 60 * 1000) return; // 10 分钟内跑过，正常
  lastDoctorRun = now;
  try {
    execFileSync('schtasks', ['/run', '/tn', 'QQStackDoctor'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    decide('巡检-没在跑', '手动触发 QQStackDoctor', last ? `上次 ${Math.round((now - last) / 60000)} 分钟前` : '查不到上次时间');
  } catch (e) {
    decide('巡检-触发失败', '记一笔', e.message);
  }
}

function trimLogs() {
  let dirs = [];
  try { dirs = [STATE, path.join(ROOT, 'stack-guard'), path.join(ROOT, 'stack-doctor')]; } catch {}
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')); } catch { continue; }
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (st.size < LOG_MAX_BYTES) continue;
        const keep = fs.readFileSync(p, 'utf8').split('\n').slice(-1500).join('\n');
        fs.writeFileSync(p, keep);
        decide('日志-太大', '裁剪 ' + f, `${Math.round(st.size / 1048576)}MB → 1500 行`);
      } catch {}
    }
  }
}

async function reviewStack() {
  let napcat = false;
  let bridge = false;
  try { napcat = await portOpen(PORTS.napcat); } catch {}
  try { bridge = await portOpen(PORTS.bridge); } catch {}

  if (!napcat) napcatDownStreak += 1; else napcatDownStreak = 0;

  if (napcat && !bridge) bridge = startBridge(); // 拉起来了就先按通了算，下一个 60 秒会纠正
  if (bridge) { bridgeBackoffUntil = 0; try { fs.unlinkSync(path.join(STATE, 'ALERT-bridge.txt')); } catch {} }

  // NapCat 断了不自己乱拉（要一次 UAC，且登录有预算）—— 交给巡检，但确认巡检真的在跑
  if (!napcat && napcatDownStreak >= 3) {
    decide('NapCat-断', '交给巡检处理', `${napcatDownStreak * 20}s 没起来`);
    ensureDoctor();
  }
  if (napcat && bridge) lastDoctorRun = 0;

  lastStack = { napcat, bridge };
  return { napcat, bridge };
}

// ── 主流程 ──────────────────────────────────────────────────────────

async function main() {
  if (STATUS_ONLY) { printStatus(); return; }
  if (DECISIONS_ONLY) { printDecisions(); return; }

  singleInstance('brain');
  log('主脑启动');
  takeOverSupervisor();
  claimSupervisorRole();

  for (const w of registry()) {
    workers.push({
      ...w, child: null, restarts: 0, lastStart: 0, lastExit: null,
      recentExits: [], quarantineUntil: 0, brokenUntil: 0, brokenWhy: '', restartTimer: null,
    });
  }
  if (!workers.length) { log('注册表读不出任何 worker，退出'); process.exitCode = 1; return; }

  for (const w of workers) { killOrphan(w.name); start(w); }
  // 先探一次端口再落盘：否则头 60 秒的状态页会把「通」写成「断」
  const s0 = await reviewStack().catch(() => ({}));
  writeStatus(s0);

  const writeTimer = setInterval(() => { if (!stopping) writeStatus(); }, 20000);

  // 每 20 秒：worker 层（便宜）
  const workerTimer = setInterval(() => {
    if (stopping) return;
    try { reviewWorkers(); } catch (e) { log('reviewWorkers 出错：' + e.message); }
  }, 20000);

  // 每 60 秒：整条链（端口探测有开销）+ 磁盘
  const stackTimer = setInterval(() => {
    if (stopping) return;
    reviewStack()
      .then((s) => writeStatus(s))
      .catch((e) => log('reviewStack 出错：' + e.message));
    try { trimLogs(); } catch (e) { log('trimLogs 出错：' + e.message); }
  }, 60000);

  if (ONCE) {
    setTimeout(async () => {
      const s = await reviewStack().catch(() => ({}));
      writeStatus(s);
      stopAll();
      clearInterval(writeTimer);
      clearInterval(workerTimer);
      clearInterval(stackTimer);
      process.exitCode = 0;
    }, 3000);
    return;
  }

  // 优雅退出：把子进程一起收掉，别留孤儿
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      log(`收到 ${sig}，收掉所有 worker`);
      try { fs.appendFileSync(DEC_LOG, JSON.stringify({ at: new Date().toISOString(), rule: '主脑退出', action: sig, detail: '' }) + '\n'); } catch {}
      stopAll();
      setTimeout(() => process.exit(0), 1500);
    });
  }
  process.on('uncaughtException', (e) => log('主脑未捕获异常（继续跑）：' + String(e && e.stack ? e.stack : e).slice(0, 300)));
  process.on('unhandledRejection', (e) => log('主脑未处理的 rejection（继续跑）：' + String(e).slice(0, 300)));
}

await main();
