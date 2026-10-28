#!/usr/bin/env node
/**
 * patrol —— 每日巡检
 *
 * 检查：端口 3000/3001/3100、QQ/node/DSH 进程、余额、bridge.log 最近错误
 * 有问题才发 QQ 通知；结果写 reports/patrol-<date>.log
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execSync } from 'node:child_process';
import { notify } from '../notify/notify.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');
const STATE = path.join(BRIDGE, 'state');
const REPORTS = path.join(ROOT, 'reports');
const OWNER = YOUR_QQ;
const BALANCE_WARN = Number(process.env.BALANCE_WARN || 5);

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

function log(...a) {
  const line = `[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}] ${a.join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(REPORTS, { recursive: true });
    fs.appendFileSync(path.join(REPORTS, `patrol-${today()}.log`), line + '\n');
  } catch {}
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(2000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function balance() {
  try {
    const t = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const k = t.match(/DEEPSEEK_API_KEY:\s*(sk-[A-Za-z0-9_-]+)/)[1];
    const r = await fetch('https://api.deepseek.com/user/balance', { headers: { authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const c = (j.balance_infos || [])[0];
    return { total: Number(c?.total_balance ?? 0), currency: c?.currency || 'CNY' };
  } catch (e) {
    return { error: e.message };
  }
}

function procCount(name) {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${name}" /NH`, { encoding: 'utf8', windowsHide: true });
    return (out.match(new RegExp(name.replace('.exe', ''), 'gi')) || []).length;
  } catch { return -1; }
}

function recentErrors(n = 5) {
  try {
    const lines = fs.readFileSync(path.join(STATE, 'bridge.log'), 'utf8').split('\n').slice(-60);
    const benign = /(重连中|未连接|不可用|icacls|EPERM|SnowLuma 错误：\{\}|token 自愈失败|看门狗第)/;
    return lines
      .filter((l) => /错误|失败|ERROR/i.test(l) && !benign.test(l))
      .slice(-n);
  } catch { return []; }
}

const problems = [];
const p3000 = await portOpen(3000);
const p3001 = await portOpen(3001);
const p3100 = await portOpen(3100);
if (!p3000) problems.push('NapCat HTTP(3000) 没起来');
if (!p3001) problems.push('NapCat WS(3001) 没起来');
if (!p3100) problems.push('桥接控制台(3100) 没起来');

const qq = procCount('QQ.exe');
const nodeN = procCount('node.exe');
const dsh = procCount('DeepSeek Harness.exe');
// -1 表示没法查（权限/沙箱限制），当作未知，不当故障
if (qq === 0) problems.push('QQ 进程不见了');
if (nodeN === 0) problems.push('node 进程不见了（桥接/看门狗）');
if (dsh === 0) problems.push('DSH 没在运行');
if (qq < 0 || nodeN < 0 || dsh < 0) log('进程数无法读取（权限不足），本次跳过进程检查');

const bal = await balance();
if (bal.error) problems.push(`余额查询失败：${bal.error}`);
else if (bal.total < BALANCE_WARN) problems.push(`余额只剩 ${bal.total} ${bal.currency}`);

const errs = recentErrors();
if (errs.length >= 5) problems.push(`日志最近有 ${errs.length} 条异常`);

log(`端口 3000=${p3000} 3001=${p3001} 3100=${p3100} | 进程 QQ=${qq} node=${nodeN} DSH=${dsh} | 余额=${bal.error ? 'ERR' : bal.total}`);

if (!problems.length) {
  log('一切正常');
} else {
  log('发现问题:', problems.join(' / '));
  // 自己处理：缺什么就把对应任务拉起来，不打扰主人
  const fixes = [];
  if (!p3000 || !p3001) fixes.push(['NapCatAtLogon', 'NapCat']);
  if (!p3100) fixes.push(['QQBridgeAtLogon', '桥接']);
  if (dsh === 0) fixes.push(['DeepSeekHarnessAtLogon', 'DSH']);
  for (const [task, label] of fixes) {
    try {
      execSync(`schtasks /run /tn "${task}"`, { windowsHide: true, stdio: 'ignore' });
      log(`已尝试启动 ${label}（任务 ${task}）`);
    } catch (e) {
      log(`启动 ${label} 失败：${e.message}`);
    }
  }
  if (fixes.length) {
    await new Promise((r) => setTimeout(r, 30000));
    const retry = [];
    if (!(await portOpen(3000))) retry.push('3000');
    if (!(await portOpen(3001))) retry.push('3001');
    if (!(await portOpen(3100))) retry.push('3100');
    if (retry.length) {
      log(`处理后仍不通：${retry.join(',')}`);
      await notify(`[QQ Bot] 自愈失败：端口 ${retry.join(',')} 仍未恢复（${problems.join(' / ')}）`);
    } else {
      log('处理完成，已恢复');
    }
  }
}
