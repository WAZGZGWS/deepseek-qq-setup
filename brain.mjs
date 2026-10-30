#!/usr/bin/env node
/**
 * brain —— 主脑：仲裁 + 执行。
 *
 * 哥定的结构（2026-10-30）：
 *   左脑 hemis/left.mjs    安全/封号：只回「账号动作能不能做」，外加它自己的安全动作
 *   右脑 hemis/right.mjs   运行逻辑：只回「服务/worker 该怎么修」
 *   主脑（本文件）          仲裁 + 执行：右脑的提案过左脑的闸门，冲突时右脑那一项下线；
 *                          左脑自己坏了就用最严的静态策略（账号动作全禁）
 *
 * 为什么要分两个脑，而不是一个文件里写两段 if：
 *   「让服务活着」和「别把号搞没」是会互相顶的（QQ 掉了，右脑想立刻重登，左脑说今天次数到顶了）。
 *   混在一起写，最后一定是「谁后改的那行代码赢」，出事了说不清是哪条规矩被越过。
 *   分开之后：右脑永远只能提，左脑永远只能否，越权在结构上就不成立。
 *
 * 九个 worker 仍然是独立进程（塞一个进程里，一个崩全崩）。
 *
 * 用法：
 *   node brain.mjs            前台运行（开机由 20-supervisor.bat 拉起）
 *   node brain.mjs --status   总状态 + 最近决策
 *   node brain.mjs --hemis    两个脑现在什么状态、手里有什么规矩、最近几次冲突
 *   node brain.mjs --decisions 最近 20 条决策
 *   node brain.mjs --once     跑一轮就退（调试用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, BRIDGE, STATE, stamp, portOpen } from './lib/base.mjs';
import { singleInstance } from './lock/single.mjs';
import { WORKER_NAMES } from './supervisor/workers.mjs';
// 三个脑用动态 import：某个脑「救不活」时，主脑可以重建一个新的
// （换个 ?gen= 参数就是全新的模块实例，状态清零、函数重新加载）。
let hemiGen = { left: 0, right: 0, cerebellum: 0 };
let left = await import('./hemis/left.mjs');
let right = await import('./hemis/right.mjs');
let cerebellum = await import('./hemis/cerebellum.mjs');
import * as leftHand from './hands/left-hand.mjs';
import * as rightHand from './hands/right-hand.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRAIN_STATE = path.join(STATE, 'brain.json');
const BRAIN_LOG = path.join(STATE, 'brain.log');
const DEC_LOG = path.join(STATE, 'brain-decisions.jsonl');
const SUP_LOCK = path.join(STATE, 'supervisor.lock');
const RIGHT_STATE = path.join(STATE, 'right-brain.json');
const MOUTH_REPORT = path.join(STATE, 'mouth-report.json');
const HEAL_QUEUE = path.join(STATE, 'heal-queue.json');
const STATUS_ONLY = process.argv.includes('--status');
const HEMIS_ONLY = process.argv.includes('--hemis');
const DECISIONS_ONLY = process.argv.includes('--decisions');
const ONCE = process.argv.includes('--once');

const QUARANTINE_MS = 10 * 60 * 1000;
const BROKEN_MS = 30 * 60 * 1000;
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const CRASH_LIMIT = 4;
const LOG_MAX_BYTES = 8 * 1024 * 1024;
const VIOLATION_WINDOW_MS = 10 * 60 * 1000;
const VIOLATION_LIMIT = 3;          // 右脑 10 分钟内被否 3 次 → 它自己下线 15 分钟
const RIGHT_OFFLINE_MS = 15 * 60 * 1000;
const CONFLICT_KEEP = 10;

const workers = [];
const decisions = [];
const conflicts = [];
const hemis = {
  left: { status: 'online', errors: 0, notes: [], metrics: {}, at: 0 },
  right: { status: 'online', violations: [], offlineUntil: 0, notes: [], at: 0 },
  cerebellum: { status: 'online', violations: [], offlineUntil: 0, notes: [], metrics: {}, at: 0 },
};
let lastStack = { napcat: false, bridge: false };
let stopping = false;
// 主脑的「维持」状态：NapCat 最近通的时间、这次断了多久、上次越权的时间
let napcatUpAt = 0;
let napcatDownSince = 0;
let lastOverrideAt = 0;
let lastMaintainAt = 0;
let lastHandAt = 0;
let lastQrAt = 0;

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  try { console.log(line); } catch {}
  try { fs.appendFileSync(BRAIN_LOG, line + '\n'); } catch {}
}

function decide(rule, action, detail = '') {
  const rec = { at: new Date().toISOString(), rule, action, detail };
  decisions.push(rec);
  if (decisions.length > 50) decisions.shift();
  log(`决策 ${rule} → ${action}${detail ? '（' + detail + '）' : ''}`);
  try { fs.appendFileSync(DEC_LOG, JSON.stringify(rec) + '\n'); } catch {}
  return rec;
}

// ── 基础工具 ────────────────────────────────────────────────────────

function registry() {
  const file = path.join(ROOT, 'supervisor', 'workers.mjs');
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of text.matchAll(/name:\s*'([^']+)'[\s\S]{0,200}?file:\s*path\.join\(ROOT,\s*'([^']+)',\s*'([^']+)'\)/g)) {
    out.push({ name: m[1], file: path.join(ROOT, m[2], m[3]) });
  }
  return out;
}

function lockAge(name) {
  try { return Math.round((Date.now() - fs.statSync(path.join(STATE, `${name}.lock`)).mtimeMs) / 1000); } catch { return -1; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function isNodePid(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    return /node\.exe/i.test(out);
  } catch { return false; }
}

function killTree(pid, image = 'node.exe') {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    return true;
  } catch { return false; }
}

function readPidFile(f) {
  try { return Number(fs.readFileSync(f, 'utf8').trim()) || 0; } catch { return 0; }
}

function tail(file, lines = 40) {
  try { return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

function snapshotWorkers(now) {
  return workers.map((w) => ({
    name: w.name,
    alive: !!(w.child && w.child.exitCode === null),
    pid: w.child && w.child.pid ? w.child.pid : 0,
    restarts: w.restarts,
    lastStart: w.lastStart,
    lockAgeSec: lockAge(w.name),
    quarantineUntil: w.quarantineUntil || 0,
    brokenUntil: w.brokenUntil || 0,
    restartTimer: !!w.restartTimer,
  }));
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
    hemis: {
      left: { status: hemis.left.status, notes: hemis.left.notes, metrics: hemis.left.metrics, errors: hemis.left.errors },
      right: {
        status: hemis.right.status,
        violations: hemis.right.violations.length,
        offlineSec: hemis.right.offlineUntil > now ? Math.round((hemis.right.offlineUntil - now) / 1000) : 0,
      },
      cerebellum: {
        status: hemis.cerebellum.status,
        violations: hemis.cerebellum.violations.length,
        offlineSec: hemis.cerebellum.offlineUntil > now ? Math.round((hemis.cerebellum.offlineUntil - now) / 1000) : 0,
        notes: hemis.cerebellum.notes,
        metrics: hemis.cerebellum.metrics,
      },
      conflicts: conflicts.slice(-5),
    },
    recentDecisions: decisions.slice(-5),
    ...extra,
  };
  try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(BRAIN_STATE, JSON.stringify(data, null, 2)); } catch {}
  return data;
}

function loadBrainJson() {
  try { return JSON.parse(fs.readFileSync(BRAIN_STATE, 'utf8')); } catch { return null; }
}

function printStatus() {
  const d = loadBrainJson();
  if (!d) { console.log('还没有 brain.json（主脑还没跑过）'); return; }
  console.log(`主脑 pid=${d.pid}  更新于 ${new Date(d.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log(`  NapCat:${d.napcat ? '通' : '断'}  桥接:${d.bridge ? '通' : '断'}`);
  if (d.mouth && d.mouth.summary) console.log('  嘴报：' + d.mouth.summary);
  const h = d.hemis || {};
  if (h.left) console.log(`  左脑(安全):${h.left.status}${h.left.notes && h.left.notes.length ? '  ' + h.left.notes.join(' / ') : ''}`);
  if (h.cerebellum) console.log(`  小脑(记忆/余额):${h.cerebellum.status}${h.cerebellum.offlineSec ? `  （自己下线 ${Math.ceil(h.cerebellum.offlineSec / 60)} 分钟）` : ''}${h.cerebellum.metrics && h.cerebellum.metrics.balance ? `  余额 ${h.cerebellum.metrics.balance}` : ''}`);
  if (h.right) console.log(`  右脑(运行):${h.right.status}${h.right.offlineSec ? `  （自己下线 ${Math.ceil(h.right.offlineSec / 60)} 分钟）` : ''}${h.right.violations ? `  被否 ${h.right.violations} 次` : ''}`);
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

function printHemis() {
  const d = loadBrainJson();
  if (!d || !d.hemis) { console.log('还没有左右脑状态（主脑没跑过）'); return; }
  const h = d.hemis;
  console.log('左脑（安全/封号）');
  console.log(`  状态：${h.left.status}${h.left.errors ? `（连续出错 ${h.left.errors} 次）` : ''}`);
  const m = h.left.metrics || {};
  console.log(`  现在看到：QQ 实例 ${m.qqCount ?? '?'} 个，今天登录 ${m.loginToday ?? '?'} 次，今天说了 ${m.spokenToday ?? '?'} 句，空间 ${m.qzoneToday ?? '?'} 条${m.night ? '，夜里' : ''}`);
  if (h.left.notes && h.left.notes.length) console.log('  备注：' + h.left.notes.join(' / '));
  console.log('右脑（运行逻辑）');
  console.log(`  状态：${h.right.status}${h.right.offlineSec ? `（冲突后自己下线，还剩 ${Math.ceil(h.right.offlineSec / 60)} 分钟）` : ''}`);
  console.log(`  10 分钟内被左脑否了 ${h.right.violations || 0} 次（${VIOLATION_LIMIT} 次就自己下线 ${RIGHT_OFFLINE_MS / 60000} 分钟）`);
  if (h.cerebellum) {
    const cm = h.cerebellum.metrics || {};
    console.log('小脑（记忆/输入输出/余额）');
    console.log(`  状态：${h.cerebellum.status}${h.cerebellum.offlineSec ? `（冲突后自己下线，还剩 ${Math.ceil(h.cerebellum.offlineSec / 60)} 分钟）` : ''}`);
    console.log(`  现在看到：余额 ${cm.balance ?? '?'} 元${cm.saveMode ? '（省着聊）' : ''}，记忆 ${cm.memChars ?? '?'} 字，脏数据 ${cm.memJunk ?? '?'} 处，今天 ${cm.spoken ?? '?'} 句 / 平均 ${cm.avgLen ?? '?'} 字，今天的摘要${cm.hasSummaryToday ? '有' : '还没有'}`);
    if (h.cerebellum.notes && h.cerebellum.notes.length) console.log('  备注：' + h.cerebellum.notes.join(' / '));
    console.log(`  10 分钟内被左脑否了 ${h.cerebellum.violations || 0} 次`);
  }
  if (h.conflicts && h.conflicts.length) {
    console.log('  最近冲突：');
    for (const c of h.conflicts) {
      console.log(`    ${new Date(c.at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })} ${c.side || ''} ${c.kind}：${c.why}`);
    }
  } else {
    console.log('  最近没有冲突');
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

// ── worker 生命周期（右脑提案、主脑执行） ──────────────────────────

function clearRestartTimer(w) {
  if (w.restartTimer) { clearTimeout(w.restartTimer); w.restartTimer = null; }
}

function start(w) {
  if (stopping) return false;
  if (!fs.existsSync(w.file)) {
    if (!w.reportedMissing) { decide('worker-缺文件', '跳过 ' + w.name, w.file); w.reportedMissing = true; }
    return false;
  }
  const now = Date.now();
  if (w.brokenUntil > now || w.quarantineUntil > now) return false;

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

    const t = tail(path.join(STATE, `worker-${w.name}.log`), 60);
    const miss = t.match(/Cannot find module '([^']+)'/);
    if (miss) {
      w.brokenUntil = Date.now() + BROKEN_MS;
      w.brokenWhy = '缺模块 ' + miss[1];
      decide('worker-坏依赖', '隔离 ' + w.name + ' 30 分钟', miss[1]);
      try { fs.writeFileSync(path.join(STATE, `ALERT-worker-${w.name}.txt`), `[${stamp()}] ${w.name} 缺模块 ${miss[1]}\n装好再等主脑自动重试。\n`); } catch {}
      return;
    }

    if (code === 3) {
      log(`${w.name} 因锁冲突退出（另一个实例在跑），30 秒后复查`);
    } else {
      log(`${w.name} 退出 code=${code} sig=${signal || ''}，5 秒后重启`);
      decide('worker-崩了', '重启 ' + w.name, `code=${code}${signal ? ' sig=' + signal : ''}，第 ${w.recentExits.length} 次`);
    }

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
  return true;
}

function stopAll() {
  stopping = true;
  for (const w of workers) {
    clearRestartTimer(w);
    try { if (w.child && w.child.exitCode === null) w.child.kill(); } catch {}
  }
}

// ── 接管 / 抢锁 ─────────────────────────────────────────────────────

function takeOverSupervisor() {
  const pid = readPidFile(SUP_LOCK);
  if (!pid || pid === process.pid) return;
  if (!pidAlive(pid) || !isNodePid(pid)) { try { fs.unlinkSync(SUP_LOCK); } catch {} return; }
  if (killTree(pid)) decide('接管旧 supervisor', '收掉 pid ' + pid, '两边各拉一套 worker 会互相抢锁');
  else decide('接管旧 supervisor', '收掉失败 pid ' + pid, '它可能还在抢 worker');
}

function claimSupervisorRole() {
  const beat = () => { try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(SUP_LOCK, String(process.pid)); } catch {} };
  beat();
  setInterval(beat, 20000).unref?.();
  process.on('exit', () => {
    try { if (readPidFile(SUP_LOCK) === process.pid) fs.unlinkSync(SUP_LOCK); } catch {}
  });
}

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

// ── 执行器（所有副作用都在主脑这一层） ─────────────────────────────

function spawnBridge() {
  try {
    const out = fs.openSync(path.join(STATE, 'bridge-run.log'), 'a');
    const child = spawn(process.execPath, [path.join(BRIDGE, 'src', 'bridge.js')], {
      cwd: BRIDGE, stdio: ['ignore', out, out], windowsHide: true, detached: true,
    });
    child.unref();
    try { fs.closeSync(out); } catch {}
    return { ok: true, pid: child.pid };
  } catch (e) { return { ok: false, err: e.message }; }
}

function spawnNapcat() {
  try {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'napcat-start.mjs'), '--as-user'], {
      cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: true,
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (e) { return { ok: false, err: e.message }; }
}

function runDoctor() {
  try { execFileSync('schtasks', ['/run', '/tn', 'QQStackDoctor'], { stdio: 'ignore', windowsHide: true, timeout: 15000 }); return { ok: true }; } catch (e) { return { ok: false, err: e.message }; }
}

/** 只留一个 QQ：保住 :3000 的那个进程，其余按进程树杀 */
function killExtraQQ() {
  let keep = 0;
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    for (const line of out.split('\n')) {
      if (!/:3000\b/.test(line) || !/LISTEN/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      keep = Number(cols[cols.length - 1]) || keep;
    }
  } catch {}
  let pids = [];
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    pids = [...out.matchAll(/"QQ\.exe","(\d+)"/gi)].map((m) => Number(m[1]));
  } catch {}
  const extras = pids.filter((p) => p !== keep);
  let killed = 0;
  for (const p of extras) { if (killTree(p)) killed += 1; }
  return { ok: killed > 0, keep, killed, extras };
}

function trimLogs() {
  let trimmed = 0;
  for (const dir of [STATE, path.join(ROOT, 'stack-guard'), path.join(ROOT, 'stack-doctor')]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')); } catch { continue; }
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (st.size < LOG_MAX_BYTES) continue;
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split('\n').slice(-1500).join('\n'));
        trimmed += 1;
        decide('日志-太大', '裁剪 ' + f, `${Math.round(st.size / 1048576)}MB → 1500 行`);
      } catch {}
    }
  }
  return { ok: true, trimmed };
}

async function execute(p) {
  switch (p.kind) {
    case 'start-worker': {
      const w = workers.find((x) => x.name === p.name);
      if (!w) return { ok: false, err: '没有这个 worker' };
      killOrphan(p.name);
      const ok = start(w);
      if (ok) decide('worker-补拉', '拉起 ' + p.name, p.why);
      return { ok };
    }
    case 'restart-hung': {
      const w = workers.find((x) => x.name === p.name);
      if (!w || !w.child) return { ok: false };
      decide('worker-卡死', '重启 ' + p.name, p.why);
      try { w.child.kill(); } catch {}
      return { ok: true };
    }
    case 'start-bridge': {
      const r = spawnBridge();
      if (r.ok) decide('桥接-断了', '拉起桥接 pid ' + r.pid, p.why);
      else decide('桥接-拉起失败', '记一笔', r.err);
      return r;
    }
    case 'start-napcat': {
      const r = spawnNapcat();
      if (r.ok) decide('NapCat-断', '拉起 NapCat pid ' + r.pid, p.why);
      else decide('NapCat-拉起失败', '记一笔', r.err);
      return r;
    }
    case 'run-doctor': {
      const r = runDoctor();
      if (r.ok) decide('巡检-催一下', '手动触发 QQStackDoctor', p.why);
      return r;
    }
    case 'trim-logs':
      return trimLogs();
    case 'run-memory-tidy': {
      const r = runScript('memory-tidy/memory-tidy.mjs');
      if (r.ok) decide('小脑-整理记忆', '跑 memory-tidy pid ' + r.pid, p.why);
      else decide('小脑-整理记忆失败', '记一笔', r.err);
      return r;
    }
    case 'run-memory-summary': {
      const r = runScript('memory-summary/memory-summary.mjs', p.day ? [p.day] : []);
      if (r.ok) decide('小脑-做今天摘要', '跑 memory-summary pid ' + r.pid, p.why);
      else decide('小脑-摘要失败', '记一笔', r.err);
      return r;
    }
    case 'send-mail': {
      const subject = '哥哥，我快没钱说话了';
      const body = `这边余额只剩 ${p.balance} 元了，主动找你说话我先停了（省着用）。\n充一点我就能正常唠：https://platform.deepseek.com/top_up\n（这条是主脑的小脑发的，一天最多一封）`;
      const r = sendMail(subject, body);
      if (r.ok) decide('小脑-提醒充值', '发邮件', p.why);
      else decide('小脑-提醒充值失败', '记一笔', r.err);
      return r;
    }
    case 'save-mode': {
      const r = writeSaveMode(true, p.why || '');
      if (r.ok) decide('小脑-省着聊', '主动发言关掉', p.why);
      return r;
    }
    case 'trash-files': {
      const r = leftHand.apply(ROOT, p.items || []);
      if (r.ok && r.moved) decide('左手-清垃圾', `移走 ${r.moved} 个（${Math.round((r.freed || 0) / 1048576)}MB）`, p.why || '');
      return r;
    }
    case 'clean-memory': {
      const key = (p.counts && p.counts.key) || p.key || '';
      if (!key) return { ok: false, err: '不知道删哪个会话的记忆' };
      const got = await rightHand.collect({ root: ROOT, bridgeDir: BRIDGE, key });
      // collect() 返回的是 { proposals: [{ items }] } —— 别直接读 got.items（这个字段不存在，
      // 踩过一次：右手永远「删 0 条」，但小脑的冷却也被记上了，看起来像是在干活）
      const list = (got && got.proposals && got.proposals[0] && got.proposals[0].items) || [];
      if (!list.length) return { ok: true, removed: 0 };
      const r = await rightHand.apply({ root: ROOT, bridgeDir: BRIDGE, key }, list);
      if (r.ok) decide('右手-清记忆', `删 ${r.removed} 条重复/污染`, `${p.why || ''}${r.backup ? '，备份 ' + path.basename(r.backup) : ''}`);
      return r;
    }
    default:
      return { ok: false, err: '不认识的提案 ' + p.kind };
  }
}

// ── 仲裁：右脑提，左脑否，主脑定 ───────────────────────────────────

function noteConflict(side, kind, why) {
  const c = { at: new Date().toISOString(), side, kind, why };
  conflicts.push(c);
  if (conflicts.length > CONFLICT_KEEP) conflicts.shift();
  const now = Date.now();
  const h = hemis[side];
  h.violations = h.violations.filter((t) => now - t < VIOLATION_WINDOW_MS);
  h.violations.push(now);
  decide(`冲突-${side === 'right' ? '右脑' : '小脑'}动作下线`, kind, why);
  if (h.violations.length >= VIOLATION_LIMIT && h.offlineUntil < now) {
    h.offlineUntil = now + RIGHT_OFFLINE_MS;
    h.status = 'offline';
    decide(`${side === 'right' ? '右脑' : '小脑'}-自己下线`, `${RIGHT_OFFLINE_MS / 60000} 分钟内不再提这类东西`, `${VIOLATION_LIMIT} 次冲突：${kind}`);
  }
}

function evaluateLeft(now, ports) {
  try {
    const lv = left.evaluate({ now, root: ROOT, bridgeDir: BRIDGE, ports });
    hemis.left = { status: 'online', errors: 0, notes: lv.notes || [], metrics: lv.metrics || {}, at: now };
    return lv;
  } catch (e) {
    hemis.left.errors += 1;
    if (hemis.left.status !== 'offline') decide('左脑-下线', '切到最严静态策略', e.message);
    hemis.left.status = 'offline';
    hemis.left.notes = ['它自己坏了：' + e.message];
    return left.SAFE_DEFAULT;
  }
}

function gate(p, lv) {
  // 保命动作不碰 QQ 账号，不走封号闸门：卡着只会让服务死透
  if (p.essential) return { allow: true };
  const v = lv.verdicts && lv.verdicts[p.kind];
  if (!v) return { allow: true };
  return v;
}

/** 跑一个后台脚本（memory-tidy / memory-summary 这类一次性任务） */
function runScript(rel, args = []) {
  try {
    const file = path.join(ROOT, rel);
    const child = spawn(process.execPath, [file, ...args], {
      cwd: path.dirname(file), stdio: 'ignore', windowsHide: true, detached: true,
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (e) { return { ok: false, err: e.message }; }
}

/** 余额提醒邮件：走掉线通知同一个通道（smtp 认证码是 DPAPI 加密的，不用重复配） */
function sendMail(subject, body) {
  try {
    const file = path.join(ROOT, 'tools', 'notify-offline.mjs');
    if (!fs.existsSync(file)) return { ok: false, err: '没有 notify-offline.mjs' };
    const child = spawn(process.execPath, [file, `--subject=${subject}`, `--body=${body}`], {
      cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: true,
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (e) { return { ok: false, err: e.message }; }
}

/** 小脑说的「省着聊」：落成一份策略文件，balance-watch 会读它压掉主动发言 */
function writeSaveMode(on, why = '') {
  try {
    const p = path.join(ROOT, 'state', 'cerebellum-policy.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ proactive: on ? 'off' : 'normal', why, at: new Date().toISOString() }, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, err: e.message }; }
}

/**
 * 主脑的越权：所有脑都说不行，但它判断「再不动手服务就没了」时才用。
 * 现在只开一条：NapCat 断超过 3 分钟、30 分钟内它本来是通的、且 30 分钟内没越权过。
 * 每次越权都记一条『主脑-越权』，能查、能追。
 */
function tryOverride(p, now) {
  if (p.kind !== 'start-napcat') return '';
  const downFor = napcatDownSince ? now - napcatDownSince : 0;
  const wasUp = napcatUpAt && now - napcatUpAt < 30 * 60 * 1000;
  if (downFor < 3 * 60 * 1000 || !wasUp) return '';
  if (now - lastOverrideAt < 30 * 60 * 1000) return '';
  lastOverrideAt = now;
  decide('主脑-越权', '强行拉起 NapCat', `断了 ${Math.round(downFor / 60000)} 分钟，本来 30 分钟内是通的`);
  return '主脑越权：服务不能死';
}

/** 维持：磁盘、自己的内存、左脑健康。这是主脑比所有脑都高的那一层判断 */
async function maintain(now, lv) {
  if (now - lastMaintainAt < 5 * 60 * 1000) return;
  lastMaintainAt = now;

  // 磁盘快满了：不等左手按 10 分钟一轮排队，直接清一轮
  try {
    const st = fs.statfsSync ? fs.statfsSync(ROOT) : null;
    if (st) {
      const freeGb = (st.bavail * st.bsize) / 1024 / 1024 / 1024;
      if (freeGb < 2) {
        const hp = leftHand.plan({ root: ROOT });
        if (hp.proposals && hp.proposals.length) {
          for (const p of hp.proposals) {
            const r = await execute(p);
            decide('主脑-维持', '磁盘紧张，先清垃圾', `剩 ${freeGb.toFixed(1)}GB，移走 ${r.moved || 0} 个`);
          }
        } else {
          try { fs.writeFileSync(path.join(STATE, 'ALERT-disk.txt'), `[${stamp()}] 磁盘只剩 ${freeGb.toFixed(1)}GB，没有可清的垃圾\n`); } catch {}
          decide('主脑-维持', '磁盘紧张但没垃圾可清', `剩 ${freeGb.toFixed(1)}GB`);
        }
      } else {
        try { fs.unlinkSync(path.join(STATE, 'ALERT-disk.txt')); } catch {}
      }
    }
  } catch {}

  // 自己的内存涨太大：重启自己（medic 会把它拉回来），别等着被系统换页拖死
  const rssMb = Math.round(process.memoryUsage().rss / 1048576);
  if (rssMb > 400) {
    decide('主脑-维持', '自己内存太大，重启自己', `${rssMb}MB`);
    try { fs.writeFileSync(path.join(STATE, 'brain-restart-reason.json'), JSON.stringify({ at: new Date().toISOString(), rssMb })); } catch {}
    setTimeout(() => process.exit(0), 500);
    return;
  }

  // 左脑连续抛异常：越权重置它的错误计数，让它重新评估（不绕过它的红线）
  if (hemis.left.errors >= 3) {
    decide('主脑-维持', '重置左脑异常计数', `连续 ${hemis.left.errors} 次`);
    hemis.left.errors = 0;
  }
}

/**
 * 嘴的通报：主脑据此知道「谁死了、谁摸鱼、能不能干活」。
 * 嘴自己不动手，所以这里只记一笔；真处置还是走右脑/调解。
 */
let lastMouthSig = '';
function readMouth(now) {
  const r = (() => { try { return JSON.parse(fs.readFileSync(MOUTH_REPORT, 'utf8')); } catch { return null; } })();
  if (!r) return null;
  const sig = `${(r.dead || []).join(',')}|${(r.idle || []).join(',')}`;
  if (sig !== lastMouthSig) {
    lastMouthSig = sig;
    if ((r.dead || []).length) decide('嘴报-有东西死了', (r.dead || []).join('/'), r.summary || '');
    else if ((r.idle || []).length) decide('嘴报-有人在摸鱼', (r.idle || []).join('/'), r.summary || '');
    else decide('嘴报', '全部正常', r.summary || '');
  }
  return r;
}

/**
 * 急救队列：急救员救不了 / 救到一半时把「还要谁来做」写在这里。
 * 主脑一起来就消费它 —— 这就是「被救活的脑和闲着的手要辅助复活其他脑」。
 */
function consumeHealQueue(now) {
  let q = null;
  try { q = JSON.parse(fs.readFileSync(HEAL_QUEUE, 'utf8')); } catch { return; }
  if (!q || !Array.isArray(q.items) || !q.items.length) return;
  let changed = false;
  for (const it of q.items) {
    if (it.status !== 'pending') continue;
    const ageMin = Math.round((now - (Date.parse(it.at) || now)) / 60000);
    if (it.kind === 'revive-hemi') {
      const h = hemis[it.hemi];
      if (!h) { it.status = 'skip'; changed = true; continue; }
      if (h.offlineUntil && now < h.offlineUntil) continue; // 别抢它自己的冷却
      h.status = 'online';
      h.offlineUntil = 0;
      h.violations = [];
      it.status = 'done';
      it.doneAt = new Date(now).toISOString();
      changed = true;
      decide('主脑-复活脑', it.hemi, `急救队列（等了 ${ageMin} 分钟）`);
    } else if (it.kind === 'rescue-brain') {
      it.status = 'done';
      it.doneAt = new Date(now).toISOString();
      changed = true;
      decide('主脑-接回权能', '救援任务闭环', `急救队列里的 rescue-brain（${ageMin} 分钟前）`);
    } else if (ageMin > 15) {
      it.status = 'stale';
      changed = true;
    }
  }
  if (changed) {
    try { q.at = new Date(now).toISOString(); fs.writeFileSync(HEAL_QUEUE, JSON.stringify(q, null, 2)); } catch {}
  }
}

// ── 扫码黑屏：QQ 没登进去时，把大二维码直接糊到屏幕上 ─────────────

const QR_PID = path.join(STATE, 'qr-screen.pid');

function qrScreenPid() { try { return Number(fs.readFileSync(QR_PID, 'utf8').trim()) || 0; } catch { return 0; } }

/** 3000 端口能拿到 user_id 才算「真登进去了」（WebUI 的 CheckLoginStatus 只代表它自己那路） */
async function qqLoggedIn() {
  try {
    const r = await fetch('http://127.0.0.1:3000/get_login_info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    return !!(j && j.data && j.data.user_id);
  } catch { return null; }
}

function runQrTool(args) {
  try {
    const c = spawn(process.execPath, [path.join(ROOT, 'tools', 'qr-screen.mjs'), ...args], {
      cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: true,
    });
    c.unref();
    return true;
  } catch { return false; }
}

/** QQ 没登录（码过期/被踢）→ 拉起黑屏二维码；其余器官一律不碰 */
function ensureQrScreen(now) {
  const pid = qrScreenPid();
  if (pid && pidAlive(pid)) return;
  if (now - lastQrAt < 60000) return;
  lastQrAt = now;
  if (runQrTool([])) decide('主脑-要扫码', '拉起黑屏二维码', '其余器官照常跑，只多一块扫码屏');
}

/** 登进去了 → 把扫码屏关掉（不关白占一个窗口） */
function closeQrScreen(now) {
  const pid = qrScreenPid();
  if (!pid) return;
  if (now - lastQrAt < 30000) return;
  lastQrAt = now;
  if (runQrTool(['--close'])) decide('主脑-扫码完成', '关掉黑屏二维码', '她登进去了');
}

// ── 器官管理：摸鱼/救不活的，重拉；彻底救不活的脑，造一个新的 ─────

const ORGAN_ENTRY = {
  eye: 'eye/eye.mjs',
  medic: 'medic/medic.mjs',
  mouth: 'mouth/mouth.mjs',
  'qr-live': 'tools/qr-live.mjs',
};
const hemiFail = { left: 0, right: 0, cerebellum: 0 };
const lastOrganAt = {};

function spawnOrgan(name) {
  const rel = ORGAN_ENTRY[name];
  if (!rel) return false;
  try {
    const c = spawn(process.execPath, [path.join(ROOT, rel)], {
      cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: true,
    });
    c.unref();
    return true;
  } catch { return false; }
}

/** 造一个新的脑：换 ?gen= 拿到全新模块实例，旧的那个状态清零 */
async function reviveHemi(name, why) {
  try {
    hemiGen[name] = (hemiGen[name] || 0) + 1;
    const gen = hemiGen[name];
    const mod = await import(`./hemis/${name}.mjs?gen=${gen}`);
    if (name === 'left') left = mod;
    else if (name === 'right') right = mod;
    else if (name === 'cerebellum') cerebellum = mod;
    hemis[name] = { status: 'online', errors: 0, violations: [], offlineUntil: 0, notes: [`第 ${gen} 代`], metrics: {}, at: Date.now() };
    hemiFail[name] = 0;
    decide('主脑-造新器官', `${name} 第 ${gen} 代`, why);
    return true;
  } catch (e) {
    decide('主脑-造新器官失败', name, e.message);
    return false;
  }
}

/** 嘴说谁死了，主脑就去处理：小器官重拉，脑连续救不活就造新的 */
async function watchOrgans(mouth, now) {
  const dead = (mouth && mouth.dead) || [];
  const idle = (mouth && mouth.idle) || [];

  for (const name of ['eye', 'medic', 'mouth']) {
    // 不能只信嘴：嘴自己死了就没人报它。所以直接看各器官的锁。
    let lockPid = 0;
    try { lockPid = Number(fs.readFileSync(path.join(STATE, `${name}.lock`), 'utf8').trim()) || 0; } catch {}
    const deadByLock = !lockPid || !pidAlive(lockPid);
    if (!dead.includes(name) && !deadByLock) continue;
    if (now - (lastOrganAt[name] || 0) < 120000) continue;
    lastOrganAt[name] = now;
    if (spawnOrgan(name)) decide('主脑-重启器官', name, deadByLock ? '锁里的 pid 不在了' : '嘴报它不在');
  }

  for (const name of ['left', 'right', 'cerebellum']) {
    if (!dead.includes(name)) continue;
    const h = hemis[name] || {};
    if (h.offlineUntil && now < h.offlineUntil) continue; // 冷却没到，先别抢
    hemiFail[name] += 1;
    if (hemiFail[name] >= 3) {
      await reviveHemi(name, `连续 ${hemiFail[name]} 轮救不回来`);
    } else {
      h.status = 'online';
      h.violations = [];
      h.offlineUntil = 0;
      decide('主脑-复活脑', name, `嘴报它下线（第 ${hemiFail[name]} 次）`);
    }
  }

  // 摸鱼的 worker：锁僵住或者干脆没在跑，已经由右脑处理；这里只记一笔让它可查
  for (const item of idle) {
    if (!/worker/.test(item)) continue;
    if (now - (lastOrganAt['worker-idle'] || 0) < 300000) break;
    lastOrganAt['worker-idle'] = now;
    decide('主脑-注意摸鱼', item, '嘴报');
    break;
  }
}

// ── 自律：没用的弹窗、扫过的二维码框，自己收掉 ──────────────────

let lastDisciplineAt = 0;
async function discipline(now, ports) {
  if (now - lastDisciplineAt < 30000) return false;
  lastDisciplineAt = now;
  if (!ports.napcat) return false;
  const li = await qqLoggedIn();
  if (li === true) {
    // 已经登进去了：扫码框一律没有存在意义
    if (qrScreenPid()) { runQrTool(['--close']); decide('主脑-自律', '关掉扫过的二维码框', '已经登进去了'); }
    try { fs.unlinkSync(path.join(STATE, 'qr-black.json')); } catch {}
    return true;
  }
  if (li === false) {
    // 一直没登录、也没人扫：开了 20 分钟就收掉，别赖在屏幕上挡事
    let st = {};
    try { st = JSON.parse(fs.readFileSync(path.join(STATE, 'qr-screen.json'), 'utf8')); } catch {}
    if (st.openedAt && now - Date.parse(st.openedAt) > 20 * 60000) {
      runQrTool(['--close']);
      decide('主脑-自律', '关掉没用的扫码框', '开了 20 分钟没人扫');
      return true;
    }
  }
  return false;
}

async function reviewCycle() {
  const now = Date.now();
  let ports = { napcat: false, bridge: false };
  try { ports.napcat = await portOpen(3000); } catch {}
  try { ports.bridge = await portOpen(3100); } catch {}

  if (ports.napcat) { napcatUpAt = now; napcatDownSince = 0; }
  else if (!napcatDownSince) napcatDownSince = now;

  // 码过期 / 被踢：只要 NapCat 还在、QQ 没登进去，就把黑屏二维码糊到屏幕上。
  // 只多这一块屏，worker、桥接、其他的脑一律照常跑。
  if (ports.napcat) {
    const li = await qqLoggedIn();
    if (li === false) ensureQrScreen(now);
    else if (li === true) closeQrScreen(now);
  }

  const lv = evaluateLeft(now, ports);

  // 左脑自己的安全动作（清多余 QQ 实例等）—— 安全优先，直接执行
  for (const p of lv.proposals || []) {
    if (p.kind === 'kill-qq-extra') {
      const r = killExtraQQ();
      if (r.killed) decide('左脑-清多余实例', `杀 ${r.killed} 个，留 pid ${r.keep}`, p.why);
    }
  }

  // 右脑上线判断：它自己下线期间，只做保命动作
  if (hemis.right.offlineUntil && now >= hemis.right.offlineUntil) {
    hemis.right.status = 'online';
    hemis.right.violations = [];
    decide('右脑-恢复', '重新开始提提案', '下线时间到');
  }

  let rp = { proposals: [] };
  try {
    rp = right.plan({ now, workers: snapshotWorkers(now), ports });
    if (hemis.right.status !== 'offline') hemis.right.status = 'online';
  } catch (e) {
    hemis.right.status = 'offline';
    hemis.right.offlineUntil = now + RIGHT_OFFLINE_MS;
    decide('右脑-自己下线', '它抛异常了，主脑只保命', e.message);
    // 兜底：只补拉挂掉的 worker
    rp = {
      proposals: snapshotWorkers(now)
        .filter((w) => !w.alive && !w.quarantineUntil && !w.brokenUntil && !w.restartTimer)
        .map((w) => ({ kind: 'start-worker', name: w.name, essential: true, why: '右脑不在，主脑兜底' })),
    };
  }

  for (const p of rp.proposals) {
    if (hemis.right.status === 'offline' && !p.essential) continue;
    let verdict = gate(p, lv);
    if (!verdict.allow) {
      const ov = tryOverride(p, now);
      if (ov) verdict = { allow: true, why: ov, overridden: true };
    }
    if (!verdict.allow) { noteConflict('right', p.kind, verdict.why || '左脑否决'); continue; }
    const r = await execute(p);
    if (!r.ok && p.essential) log(`执行 ${p.kind} 没成功：${r.err || ''}`);
    try {
      right.feedback(p.kind, r.ok !== false);
      fs.writeFileSync(RIGHT_STATE, JSON.stringify(right.snapshot()));
    } catch {}
  }

  // ── 小脑：记忆 / 输入输出 / 余额 ──────────────────────────────
  if (hemis.cerebellum.offlineUntil && now >= hemis.cerebellum.offlineUntil) {
    hemis.cerebellum.status = 'online';
    hemis.cerebellum.violations = [];
    decide('小脑-恢复', '重新开始提提案', '下线时间到');
  }
  let cp = { proposals: [] };
  try {
    cp = cerebellum.plan({ now, root: ROOT, bridgeDir: BRIDGE, bridgeState: STATE });
    hemis.cerebellum.notes = cp.notes || [];
    hemis.cerebellum.metrics = cp.metrics || {};
    hemis.cerebellum.at = now;
    if (hemis.cerebellum.status !== 'offline') hemis.cerebellum.status = 'online';
  } catch (e) {
    hemis.cerebellum.status = 'offline';
    hemis.cerebellum.offlineUntil = now + RIGHT_OFFLINE_MS;
    hemis.cerebellum.notes = ['它自己坏了：' + e.message];
    decide('小脑-自己下线', '它抛异常了，主脑不管记忆和余额', e.message);
  }
  for (const p of cp.proposals || []) {
    if (hemis.cerebellum.status === 'offline') break;
    const verdict = gate(p, lv);
    if (!verdict.allow) { noteConflict('cerebellum', p.kind, verdict.why || '左脑否决'); continue; }
    const r = await execute(p);
    try { cerebellum.feedback(ROOT, p.kind, r.ok !== false); } catch {}
  }

  // ── 左手：清无用文件（每 5 分钟看一次就够，别每轮都扫盘） ────
  if (now - (lastHandAt || 0) > 5 * 60 * 1000) {
    lastHandAt = now;
    try {
      const hp = leftHand.plan({ root: ROOT });
      hemis.hands = { files: hp.metrics || {} };
      for (const p of hp.proposals || []) {
        const v = gate(p, lv);
        if (!v.allow) { decide('左手-被拦下', p.why || '', v.why || ''); continue; }
        await execute(p);
      }
      try { leftHand.emptyTrash(ROOT, 30); } catch {}
    } catch (e) { log('左手出错：' + e.message); }
  }

  lastStack = { napcat: ports.napcat, bridge: ports.bridge };
  consumeHealQueue(now);
  const mouth = readMouth(now);
  await watchOrgans(mouth, now);
  await discipline(now, ports);
  await maintain(now, lv);
  await maybeAlertHemis(now);
  writeStatus({ napcat: ports.napcat, bridge: ports.bridge, mouth });
}

/** 两个脑都下线 = 只剩保命：写告警，但不发邮件（邮件是掉线专用通道，别滥用） */
let alertedHemis = 0;
async function maybeAlertHemis(now) {
  const both = hemis.left.status === 'offline' && hemis.right.status === 'offline';
  if (!both) { alertedHemis = 0; try { fs.unlinkSync(path.join(STATE, 'ALERT-hemis.txt')); } catch {} return; }
  if (now - alertedHemis < 10 * 60 * 1000) return;
  alertedHemis = now;
  try {
    fs.writeFileSync(path.join(STATE, 'ALERT-hemis.txt'),
      `[${stamp()}] 左右脑都不在线：左脑 ${hemis.left.errors} 次异常，右脑下线中。\n` +
      `现在只执行保命动作（补拉 worker），账号动作全禁。\n` +
      `看 node brain.mjs --hemis\n`);
  } catch {}
}

// ── 主流程 ──────────────────────────────────────────────────────────

async function main() {
  if (STATUS_ONLY) { printStatus(); return; }
  if (HEMIS_ONLY) { printHemis(); return; }
  if (DECISIONS_ONLY) { printDecisions(); return; }

  singleInstance('brain');
  try { right.hydrate(JSON.parse(fs.readFileSync(RIGHT_STATE, 'utf8'))); } catch {}
  log('主脑启动（左脑=安全 / 右脑=运行 / 小脑=记忆余额，主脑仲裁）');
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
  await reviewCycle().catch((e) => log('首轮仲裁出错：' + e.message));

  const writeTimer = setInterval(() => { if (!stopping) writeStatus(); }, 20000);

  // 20 秒一轮：左右脑各说一句，主脑仲裁执行
  const cycleTimer = setInterval(() => {
    if (stopping) return;
    reviewCycle().catch((e) => log('仲裁轮出错：' + e.message));
  }, 20000);

  if (ONCE) {
    setTimeout(async () => {
      stopAll();
      clearInterval(writeTimer);
      clearInterval(cycleTimer);
      process.exitCode = 0;
    }, 3000);
    return;
  }

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
