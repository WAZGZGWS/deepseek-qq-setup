#!/usr/bin/env node
import { singleInstance } from '../lock/single.mjs';
singleInstance('cron');
/**
 * cron —— 迷你定时器（替代需要管理员权限的计划任务）
 *
 * 到点执行：
 *   03:30  补丁自检
 *   04:00  维护（日志轮转 + 备份 + 加密同步到云盘）
 *   09:00  巡检
 *   21:00  巡检
 *   22:20  记忆整理
 *   23:00  当日报告
 *   23:40  版本快照
 *
 * 每 30 秒检查一次；同一天同一任务只跑一次。
 *
 * 错过的补跑：不再要求"正好卡到那一分钟"，只要今天已过点、且距离该点
 * 没超过 CATCHUP_MIN 分钟，就补跑。这样凌晨关机错过了 04:00 备份，
 * 早上开机还能补上。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const STATE = path.join(ROOT, 'cron-state.json');

// 错过多少分钟内还补跑（分钟）
const CATCHUP_MIN = Math.max(30, Number(process.env.CATCHUP_MIN || 300));

const JOBS = [
  { id: 'patch-check', at: '03:30', file: path.join(ROOT, 'patches', 'daily-check.mjs') },
  { id: 'maintenance', at: '04:00', file: path.join(ROOT, 'maintenance', 'maintenance.mjs') },
  { id: 'patrol-morning', at: '09:00', file: path.join(ROOT, 'patrol', 'patrol.mjs') },
  { id: 'patrol-evening', at: '21:00', file: path.join(ROOT, 'patrol', 'patrol.mjs') },
  { id: 'self-check', at: '21:20', file: path.join(ROOT, 'self-check', 'self-check.mjs'), args: ['--fix'] },
  { id: 'memory-tidy', at: '22:20', file: path.join(ROOT, 'memory-tidy', 'memory-tidy.mjs') },
  { id: 'daily-report', at: '23:00', file: path.join(ROOT, 'daily-report', 'daily-report.mjs') },
  { id: 'memory-summary', at: '23:10', file: path.join(ROOT, 'memory-summary', 'memory-summary.mjs') },
  { id: 'versions', at: '23:40', file: path.join(ROOT, 'versions', 'versions.mjs') },
];

const day = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

// 当前北京时间「今天第几分钟」（0-1439）
function nowMinutes() {
  const t = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false });
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch {}
}

function log(...a) {
  const line = `[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}] ${a.join(' ')}`;
  console.log(line);
  try {
    const dir = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'cron.log'), line + '\n');
  } catch {}
}

let running = false;

function run(job) {
  log(`执行 ${job.id}（计划 ${job.at}）`);
  running = true;
  const args = Array.isArray(job.args) ? job.args : [];
  const child = spawn(process.execPath, [job.file, ...args], { stdio: 'inherit', windowsHide: true });
  child.on('exit', (code) => {
    running = false;
    log(`${job.id} 结束，退出码 ${code}`);
  });
  child.on('error', (e) => {
    running = false;
    log(`${job.id} 启动失败: ${e.message}`);
  });
}

function tick() {
  // 一次只跑一个，避免早上补跑时几个任务同时开 node 抢资源
  if (running) return;
  const d = day();
  const nowMin = nowMinutes();
  const st = readState();
  st.last = st.last || {};

  for (const job of JOBS) {
    const key = `${d} ${job.id}`;
    if (st.last[job.id] === key) continue;
    const [h, m] = job.at.split(':').map(Number);
    const jobMin = h * 60 + m;
    if (nowMin < jobMin) continue;                 // 还没到点
    if (nowMin - jobMin > CATCHUP_MIN) continue;   // 过期太久，不补
    st.last[job.id] = key;
    writeState(st);
    run(job);
    return; // 下一个任务等下一轮 tick
  }
}

log(`迷你定时器启动：${JOBS.map((j) => `${j.at} ${j.id}`).join(' / ')}（补跑窗口 ${CATCHUP_MIN} 分钟）`);
tick();
setInterval(tick, 30_000);
