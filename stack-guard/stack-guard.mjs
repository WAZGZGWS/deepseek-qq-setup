#!/usr/bin/env node
/**
 * stack-guard —— 整条链的守夜人。
 *
 * 链条是：NapCat(:3000/3001) → 桥接(:3100) → DSH，另有主脑 brain.mjs 管着 9 个后台脚本。
 * 它只负责「主脑别死」这一件事：主脑活着的时候它什么都不做。
 *
 * 每 10 秒看一次：
 *   · 主脑不在              → 拉起来（用 detached，脱离本进程，我死了它还活着）
 *   · 别的故障              → 不碰，全归主脑（它一次只做一个决定，不会两边抢着拉）
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
  // 守夜人只干一件事：主脑还活着吗。
  // 桥接/NapCat/worker 的处置全交给主脑 —— 两处都动手会互相踩（10-30 就撞过：
  // 守夜人每 10 秒拉一次桥接、主脑每 60 秒也拉，谁先谁后全看运气，日志还会说谎）。
  const brainPid = readPid('brain');
  if (!pidRuns(brainPid, 'brain.mjs')) {
    if (!warnedNoSupervisor) log(`主脑不在（锁里是 ${brainPid || '空'}），拉起来`);
    try {
      const pid = spawnDetached(path.join(ROOT, 'brain.mjs'), ROOT, 'brain-run.log');
      log(`已拉起主脑 pid ${pid}`);
      warnedNoSupervisor = false;
    } catch (e) {
      log('拉起主脑失败:', e.message);
      warnedNoSupervisor = true;
    }
    return;
  }
  warnedNoSupervisor = false;
}

log(`守夜人启动：每 ${CHECK_SEC}s 只确认主脑活着（其余故障由主脑决策）`);
await tick();
setInterval(() => void tick().catch((e) => log('检查出错:', e.message)), CHECK_SEC * 1000);
