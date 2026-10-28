#!/usr/bin/env node
import { singleInstance } from '../lock/single.mjs';
singleInstance('supervisor');
/**
 * supervisor —— 一个进程管住所有后台工人
 *
 * 为什么需要它：DSH 重启会把挂在它下面的进程全带走；而计划任务只在登录时跑一次。
 * 由登录启动的本进程独立于 DSH，负责把工人们拉起来并在崩溃后 5 秒重试。
 *
 * 管理：cron / archive / session-janitor / budget-guard / balance-watch / context-guard / power-guard
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const STATE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'state');

const WORKERS = [
  { name: 'cron', file: path.join(ROOT, 'cron', 'cron.mjs') },
  { name: 'archive', file: path.join(ROOT, 'archive', 'collector.mjs') },
  { name: 'eye-drop', file: path.join(ROOT, 'eye-drop', 'eye-drop.mjs') },
  { name: 'janitor', file: path.join(ROOT, 'session-janitor', 'session-janitor.mjs') },
  { name: 'budget', file: path.join(ROOT, 'budget-guard', 'budget-guard.mjs') },
  { name: 'balance', file: path.join(ROOT, 'balance-watch', 'balance-watch.mjs') },
  { name: 'context', file: path.join(ROOT, 'context-guard', 'context-guard.mjs') },
  { name: 'power', file: path.join(ROOT, 'power-guard', 'power-guard.mjs') },
];

const procs = new Map();

function log(...a) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${a.join(' ')}`;
  // 无窗口启动时 stdout 可能是无效句柄，console.log 会抛 EPIPE/EINVAL 把整个进程带走。
  // 日志以文件为准，控制台只是顺便。
  try { console.log(line); } catch {}
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(path.join(STATE, 'supervisor.log'), line + '\n');
  } catch {}
}

// 每个 worker 连续"刚起来就退出"的次数。超过阈值就退避，避免死循环刷日志。
// 典型场景：另一个同名实例已经持有心跳锁（比如 cron 被手动起过），
// 新实例按设计 exit(0) 让位，但 supervisor 以为它崩了，于是每 5 秒重开一次，永远刷。
const fastExits = new Map();
const lockConflicts = new Map();
const FAST_MS = 8000;

function start(worker) {
  if (procs.has(worker.name)) return;
  if (!fs.existsSync(worker.file)) { log(`跳过 ${worker.name}：找不到 ${worker.file}`); return; }
  const startedAt = Date.now();
  const child = spawn(process.execPath, [worker.file], { stdio: 'ignore', windowsHide: true });
  procs.set(worker.name, child);
  log(`启动 ${worker.name} (pid ${child.pid})`);
  child.on('exit', (code, sig) => {
    procs.delete(worker.name);
    const lived = Date.now() - startedAt;
    let delay = 5000;
    if (code === 3) {
      // 退出码 3：已经有同名实例在跑（锁冲突），不是崩溃。
      // 别每 5 秒起一个注定失败的克隆，但也别一上来就等 5 分钟 ——
      // 旧一代 worker 跟着上一代 supervisor 一起退出时，锁会在 90 秒后过期，
      // 那之后新实例就能接管。所以 60s、120s、180s… 最多 5 分钟。
      const n3 = (lockConflicts.get(worker.name) || 0) + 1;
      lockConflicts.set(worker.name, n3);
      const d3 = Math.min(300000, 60000 * n3);
      log(`${worker.name} 已有实例在跑（锁冲突，第 ${n3} 次），${Math.round(d3 / 1000)} 秒后再检查`);
      setTimeout(() => start(worker), d3);
      return;
    }
    if (lived < FAST_MS && code === 0) {
      // 很快就干净退出：多半是锁冲突（别的实例在跑），别每 5 秒刷一次
      const n = (fastExits.get(worker.name) || 0) + 1;
      fastExits.set(worker.name, n);
      delay = Math.min(300000, 15000 * n);
      log(`${worker.name} 刚启动就退出（第 ${n} 次，多半是另一个实例持有锁），${Math.round(delay / 1000)} 秒后再试`);
    } else {
      if (lived >= FAST_MS) { fastExits.delete(worker.name); lockConflicts.delete(worker.name); }
      log(`${worker.name} 退出 code=${code} sig=${sig || ''}，${Math.round(delay / 1000)} 秒后重启`);
    }
    setTimeout(() => start(worker), delay);
  });
  child.on('error', (e) => {
    procs.delete(worker.name);
    log(`${worker.name} 启动失败: ${e.message}`);
    setTimeout(() => start(worker), 10000);
  });
}

log('总管启动，接管 7 个后台工人');
for (const w of WORKERS) start(w);

process.on('exit', () => {
  for (const [, c] of procs) { try { c.kill(); } catch {} }
});
