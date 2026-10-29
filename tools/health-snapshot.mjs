#!/usr/bin/env node
/**
 * health-snapshot —— 中午/下午各拍一张「她当时还活着吗」的快照。
 *
 * 为什么单独做：这四天都是下午失联，晚上回来才知道，而且分不清是
 * 「机器睡了」还是「QQ 被踢了」。有快照就能当天定位，不用复盘猜。
 *
 * 写 state/health-snapshots.jsonl，一行一次；顺手留一份最新在 state/health-last.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, STATE, stamp, today, portOpen } from '../lib/base.mjs';

const OUT = path.join(STATE, 'health-snapshots.jsonl');
const LAST = path.join(STATE, 'health-last.json');

function qqLogin() {
  try {
    const r = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'qq-login.mjs'), 'status'], {
      encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    const first = String(r || '').trim().split('\n')[0] || '';
    if (first.startsWith('已登录')) return { online: true, text: first.slice(0, 60) };
    return { online: false, text: first.slice(0, 60) };
  } catch (e) {
    return { online: false, text: '查询失败：' + String(e.message || e).slice(0, 60) };
  }
}

function standby24h() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; StartTime=(Get-Date).AddHours(-24)} -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq 506 } | Measure-Object).Count",
    ], { encoding: 'utf8', windowsHide: true, timeout: 25000 });
    return Number(String(out || '').trim() || 0);
  } catch { return -1; }
}

function lastArchiveLine() {
  try {
    const f = path.join(ROOT, 'archive', 'logs', `${today()}.md`);
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    return lines[lines.length - 1].slice(0, 60);
  } catch { return '(没有今天的档案)'; }
}

function keepAwakeBeat() {
  try { return Math.round((Date.now() - fs.statSync(path.join(ROOT, 'state', 'keep-awake.heartbeat')).mtimeMs) / 1000); }
  catch { return -1; }
}

const snap = {
  at: new Date().toISOString(),
  local: stamp(),
  qq: qqLogin(),
  port3000: await portOpen(3000),
  port3100: await portOpen(3100),
  standby24h: standby24h(),
  keepAwakeBeatSec: keepAwakeBeat(),
  lastArchive: lastArchiveLine(),
};

try {
  fs.mkdirSync(STATE, { recursive: true });
  fs.appendFileSync(OUT, JSON.stringify(snap) + '\n');
  fs.writeFileSync(LAST, JSON.stringify(snap, null, 2));
} catch {}

console.log(`[${stamp()}] 快照：QQ=${snap.qq.online ? '在线' : '离线'} 3000=${snap.port3000} 3100=${snap.port3100} 24h待机=${snap.standby24h} 保持唤醒=${snap.keepAwakeBeatSec}s | 档案最后一条：${snap.lastArchive}`);
