#!/usr/bin/env node
/**
 * brain —— 全栈主脑：一个入口管住所有后台脚本。
 *
 * 为什么不是「把 9 个脚本塞进同一个进程」：
 *   9 个 worker 全是常驻定时任务，塞一个进程里的话——一个未捕获异常、一次内存泄漏、
 *   一个卡死的同步调用，就会让**全部 9 个一起死**（连巡检都没人跑）。今天已经够折腾了。
 *   所以主脑管的是「启动/守护/状态/日志」，每个 worker 仍然独立进程跑，崩一个不连坐。
 *
 * 它替掉的是原来分散的三处职责：supervisor（拉进程）+ stack-guard（守窗口）+ 
 * doctor 里的「worker 锁数量」判断 —— 现在统一到这里，看状态只有一条命令。
 *
 * 用法：
 *   node brain.mjs            前台运行（带守护，建议由 20-supervisor.bat 拉起）
 *   node brain.mjs --status   只看状态（谁在跑、重启几次、多久没心跳）
 *   node brain.mjs --once     起一遍就退（调试用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, STATE, stamp, portOpen } from './lib/base.mjs';
import { singleInstance } from './lock/single.mjs';
import { WORKER_NAMES } from './supervisor/workers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRAIN_STATE = path.join(STATE, 'brain.json');
const BRAIN_LOG = path.join(STATE, 'brain.log');
const STATUS_ONLY = process.argv.includes('--status');
const ONCE = process.argv.includes('--once');

const workers = [];   // { name, file, child, restarts, lastStart, lastExit }
let stopping = false;

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  try { console.log(line); } catch {}
  try { fs.appendFileSync(BRAIN_LOG, line + '\n'); } catch {}
}

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

function writeStatus(extra = {}) {
  const now = Date.now();
  const rows = workers.map((w) => {
    const beat = lockAge(w.name);
    return {
      name: w.name,
      pid: w.child && w.child.pid ? w.child.pid : 0,
      alive: !!(w.child && w.child.exitCode === null),
      restarts: w.restarts,
      uptimeSec: w.lastStart ? Math.round((now - w.lastStart) / 1000) : 0,
      lockAgeSec: beat,
    };
  });
  const data = {
    at: new Date().toISOString(),
    pid: process.pid,
    workers: rows,
    missing: WORKER_NAMES.filter((n) => !rows.some((r) => r.name === n)),
    ...extra,
  };
  try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(BRAIN_STATE, JSON.stringify(data, null, 2)); } catch {}
  return data;
}

/** 锁文件多久没刷新（秒）——worker 每 20 秒摸一次自己的锁 */
function lockAge(name) {
  try {
    const f = path.join(STATE, `${name}.lock`);
    return Math.round((Date.now() - fs.statSync(f).mtimeMs) / 1000);
  } catch {
    return -1;
  }
}

const SUP_LOCK = path.join(STATE, 'supervisor.lock');

/** pid 还活着吗（EPERM = 有权限问题但进程在） */
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

/**
 * 接管旧 supervisor。
 *
 * 它自己拉起一整套 worker，主脑也拉起一套 —— 两边抢单实例锁，结果是
 * 「主脑的 9 个子进程全因锁冲突退出，锁还被旧 supervisor 的 worker 占着」。
 * 10-30 晚上就是这么撞上的：brain --status 全显示「停了」，实际在跑的是 supervisor 的后代。
 * 所以启动时先把旧的那棵树收掉（/T 连子进程一起）。
 */
function takeOverSupervisor() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(SUP_LOCK, 'utf8').trim()); } catch { return; }
  if (!pid || pid === process.pid) return;
  if (!pidAlive(pid)) { try { fs.unlinkSync(SUP_LOCK); } catch {} return; }
  if (!isNodePid(pid)) { try { fs.unlinkSync(SUP_LOCK); } catch {} return; }
  if (killTree(pid)) log(`接管：旧 supervisor pid ${pid} 和它的 worker 已下线`);
  else log(`接管旧 supervisor pid ${pid} 失败，它可能还在和主脑抢 worker`);
}

/**
 * 占住 supervisor 的角色锁：只要主脑活着，supervisor 起不来（它会自己退出码 3）。
 * 少了这一步，巡检觉得「supervisor 不在」又拉一个，又把 9 个 worker 抢走。
 */
function claimSupervisorRole() {
  const beat = () => {
    try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(SUP_LOCK, String(process.pid)); } catch {}
  };
  beat();
  setInterval(beat, 20000).unref?.();
  process.on('exit', () => {
    try { if (Number(fs.readFileSync(SUP_LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(SUP_LOCK); } catch {}
  });
}

/** 锁被人占着、但那不是我的子进程 → 孤儿回收（只认 node 进程，别杀错） */
function killOrphan(name) {
  const f = path.join(STATE, `${name}.lock`);
  let pid = 0;
  try { pid = Number(fs.readFileSync(f, 'utf8').trim()); } catch { return; }
  if (!pid || pid === process.pid) return;
  if (workers.some((w) => w.child && w.child.pid === pid)) return;
  if (!pidAlive(pid) || !isNodePid(pid)) { try { fs.unlinkSync(f); } catch {} return; }
  if (lockAge(name) >= 0 && lockAge(name) > 90) { try { fs.unlinkSync(f); } catch {} return; }
  if (killTree(pid)) log(`清掉孤儿 ${name} pid ${pid}（锁被它占着）`);
  try { fs.unlinkSync(f); } catch {}
}

function start(w) {
  if (!fs.existsSync(w.file)) { log(`缺文件：${w.name} → ${w.file}`); return; }
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
  w.lastStart = Date.now();
  log(`启动 ${w.name} pid=${child.pid}`);
  child.on('exit', (code, signal) => {
    w.lastExit = { code, signal, at: Date.now() };
    if (stopping) return;
    // 退出码 3 = 单实例锁冲突（另一个实例在跑），不用急着重启
    if (code === 3) { log(`${w.name} 因锁冲突退出（另一个实例在跑），30 秒后复查`); }
    else log(`${w.name} 退出 code=${code} sig=${signal || ''}，5 秒后重启`);
    w.restarts += 1;
    const delay = code === 3 ? 30000 : 5000;
    setTimeout(() => { if (!stopping) start(w); }, delay);
  });
}

function stopAll() {
  stopping = true;
  for (const w of workers) {
    try { if (w.child && w.child.exitCode === null) w.child.kill(); } catch {}
  }
}

function printStatus() {
  const d = (() => { try { return JSON.parse(fs.readFileSync(BRAIN_STATE, 'utf8')); } catch { return null; } })();
  if (!d) { console.log('还没有 brain.json（主脑还没跑过）'); return; }
  console.log(`主脑 pid=${d.pid}  更新于 ${new Date(d.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log('  名字        状态    pid      重启  锁心跳');
  for (const r of d.workers) {
    const beat = r.lockAgeSec < 0 ? '无锁' : `${r.lockAgeSec}s`;
    console.log(`  ${r.name.padEnd(10)} ${r.alive ? '在跑' : '停了'}  ${String(r.pid).padEnd(8)} ${String(r.restarts).padEnd(5)} ${beat}`);
  }
  if (d.missing && d.missing.length) console.log('  名单上缺：' + d.missing.join(','));
}

async function main() {
  if (STATUS_ONLY) { printStatus(); return; }

  singleInstance('brain');
  log('主脑启动');
  takeOverSupervisor();
  claimSupervisorRole();

  for (const w of registry()) {
    workers.push({ ...w, child: null, restarts: 0, lastStart: 0, lastExit: null });
  }
  if (!workers.length) { log('注册表读不出任何 worker，退出'); process.exitCode = 1; return; }

  for (const w of workers) { killOrphan(w.name); start(w); }
  writeStatus();

  const tick = setInterval(() => { if (!stopping) writeStatus(); }, 20000);
  if (ONCE) { setTimeout(() => { stopAll(); clearInterval(tick); process.exitCode = 0; }, 3000); return; }

  // 优雅退出：把子进程一起收掉，别留孤儿
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { log(`收到 ${sig}，收掉所有 worker`); stopAll(); setTimeout(() => process.exit(0), 1500); });
  }
  process.on('uncaughtException', (e) => log('主脑未捕获异常（继续跑）：' + String(e && e.stack ? e.stack : e).slice(0, 300)));
  process.on('unhandledRejection', (e) => log('主脑未处理的 rejection（继续跑）：' + String(e).slice(0, 300)));

  setInterval(() => {
    // 心跳表：谁连续 5 分钟没摸锁、也没在跑 → 拉起来
    for (const w of workers) {
      if (w.child && w.child.exitCode === null) continue;
      if (stopping) continue;
      killOrphan(w.name);
      const age = lockAge(w.name);
      if (age >= 0 && age < 120) continue; // 别的实例还活着（可能是我刚重启的）
      log(`${w.name} 不在跑（锁 ${age < 0 ? '无' : age + 's'}），重新拉起`);
      start(w);
    }
  }, 60000);
}

await main();
