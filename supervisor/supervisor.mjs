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

function start(worker) {
  if (procs.has(worker.name)) return;
  if (!fs.existsSync(worker.file)) { log(`跳过 ${worker.name}：找不到 ${worker.file}`); return; }
  const child = spawn(process.execPath, [worker.file], { stdio: 'ignore', windowsHide: true });
  procs.set(worker.name, child);
  log(`启动 ${worker.name} (pid ${child.pid})`);
  child.on('exit', (code, sig) => {
    procs.delete(worker.name);
    log(`${worker.name} 退出 code=${code} sig=${sig || ''}，5 秒后重启`);
    setTimeout(() => start(worker), 5000);
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
