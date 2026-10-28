#!/usr/bin/env node
/**
 * stack-guard —— 整条链的守夜人。
 *
 * 链条是：NapCat(:3000/3001) → 桥接(:3100) → DSH，另有 supervisor 管着 7 个后台脚本。
 * 任何一环普通权限能救的，这里都救了；唯独 NapCat 要过一次 UAC，救不了，只能提示。
 *
 * 每 10 秒看一次：
 *   · supervisor 不在        → 拉起来（用 detached，脱离本进程，我死了它还活着）
 *   · :3100 断 & :3000 通    → 拉起桥接
 *   · :3000 断               → NapCat 没起，不硬拉桥接（拉了也连不上）
 *
 * 判活不能只看 pid —— Windows 会复用 pid。必须核对命令行里跑的是不是那个脚本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { ROOT, BRIDGE, STATE, stamp, portOpen, dirOf } from '../lib/base.mjs';

const HERE = dirOf(import.meta.url);

const CHECK_SEC = 10;

// 单例锁（放本目录，state/ 的 ACL 收得比较紧）
const LOCK = path.join(HERE, 'stack-guard.lock');
try {
  const old = Number(fs.readFileSync(LOCK, 'utf8').trim());
  if (old && old !== process.pid) {
    try { process.kill(old, 0); process.exit(0); } catch {}
  }
} catch {}
try { fs.writeFileSync(LOCK, String(process.pid)); } catch {}

function log(...a) {
  const line = `[${stamp()}] ${a.join(' ')}`;
  try { console.log(line); } catch {}
  try { fs.appendFileSync(path.join(HERE, 'stack-guard.log'), line + '\n'); } catch {}
}

/** pid 活着、而且命令行里确实是这个脚本（防 pid 复用） */
function pidRuns(pid, scriptName) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'win32') return true;
  try {
    const out = execFileSync('wmic', ['process', 'where', `processid=${pid}`, 'get', 'commandline', '/value'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    if (out && out.includes('CommandLine=')) return out.includes(scriptName);
  } catch {}
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    return /node\.exe/i.test(out);
  } catch {}
  return true;
}

function readPid(name) {
  try { return Number(fs.readFileSync(path.join(STATE, `${name}.lock`), 'utf8').trim()) || 0; } catch { return 0; }
}

function spawnDetached(scriptPath, cwd, logName) {
  const out = fs.openSync(path.join(HERE, logName), 'a');
  const child = spawn(process.execPath, [scriptPath], {
    cwd,
    stdio: ['ignore', out, out],
    windowsHide: true,
    detached: true,
  });
  child.unref(); // 脱离本进程：我死了它也活着
  return child.pid;
}

let lastUp = true;
let warnedNoNapCat = false;
let warnedNoSupervisor = false;

async function tick() {
  // ── 1. supervisor ────────────────────────────────────────────────
  const supPid = readPid('supervisor');
  if (!pidRuns(supPid, 'supervisor.mjs')) {
    if (!warnedNoSupervisor) log(`supervisor 不在（锁里是 ${supPid || '空'}），拉起来`);
    try {
      const pid = spawnDetached(path.join(ROOT, 'supervisor', 'supervisor.mjs'), ROOT, 'supervisor-run.log');
      log(`已拉起 supervisor pid ${pid}`);
      warnedNoSupervisor = false;
    } catch (e) {
      log('拉起 supervisor 失败:', e.message);
      warnedNoSupervisor = true;
    }
  }

  // ── 2. 桥接 ─────────────────────────────────────────────────────
  if (await portOpen(3100)) {
    if (!lastUp) { log('桥接已就绪'); lastUp = true; }
    warnedNoNapCat = false;
    return;
  }

  if (!(await portOpen(3000))) {
    if (!warnedNoNapCat) {
      log('NapCat(:3000) 还没起来，先不拉桥接 —— 等你点完那个 UAC 再连');
      warnedNoNapCat = true;
    }
    return;
  }

  if (!(await portOpen(3100))) {
    try {
      const pid = spawnDetached(path.join(BRIDGE, 'src', 'bridge.js'), BRIDGE, 'bridge-run.log');
      log(`NapCat 在线，已拉起桥接 pid ${pid}`);
      lastUp = false;
    } catch (e) {
      log('拉起桥接失败:', e.message);
    }
  }
}

log(`守夜人启动：每 ${CHECK_SEC}s 检查 supervisor / :3000(NapCat) / :3100(桥接)`);
await tick();
setInterval(() => void tick().catch((e) => log('检查出错:', e.message)), CHECK_SEC * 1000);
