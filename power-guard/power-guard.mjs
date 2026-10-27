#!/usr/bin/env node
import { singleInstance } from '../lock/single.mjs';
singleInstance('power');
/**
 * power-guard —— 断电/拔电源时先把记忆存好再关机
 *
 * 每 60 秒看一次电源状态（笔记本电池）：
 *   · 插着电 → 正常，重置倒计时
 *   · 拔掉电 → 开始倒计时（默认 8 分钟；电量 < 20% 时缩到 2 分钟）
 *   · 倒计时结束 → 存记忆 → 归档一次 → 备份 → 关机
 *   · 中途插回电 → 取消关机
 *
 * 另外每 5 分钟把记忆做一次热快照（chat-memory/live.json），
 * 这样哪怕直接断电，最多丢 5 分钟的对话上下文（历史仍在档案里）。
 *
 * 环境变量：GRACE_MIN(8) CRITICAL_PCT(20) CRITICAL_GRACE_MIN(2) SNAPSHOT_MIN(5) DRY_RUN=1
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');
const STATE = path.join(BRIDGE, 'state');
const MEMDIR = path.join(ROOT, 'chat-memory');
const KEY = process.env.CHAT_KEY || 'private:YOUR_QQ';
const GRACE_MIN = Number(process.env.GRACE_MIN || 8);
const CRITICAL_PCT = Number(process.env.CRITICAL_PCT || 20);
const CRITICAL_GRACE_MIN = Number(process.env.CRITICAL_GRACE_MIN || 2);
const SNAPSHOT_MIN = Number(process.env.SNAPSHOT_MIN || 5);
const DRY = process.env.DRY_RUN === '1';

let unpluggedAt = 0;
let lastSnapshotAt = 0;
let shuttingDown = false;

function log(...a) {
  const line = `[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(STATE, 'power.log'), line + '\n'); } catch {}
}

function readPower() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.SystemInformation]::PowerStatus; "{0}|{1}" -f $s.PowerLineStatus,$s.BatteryLifePercent',
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
    const [status, pct] = out.split('|');
    return { online: String(status).startsWith('Online'), pct: Number(pct) * 100 };
  } catch (e) {
    return { error: e.message };
  }
}

function token() {
  return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
}

async function api(p, options = {}) {
  const r = await fetch(`http://127.0.0.1:3100${p}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-console-token': token() },
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function snapshot(reason) {
  try {
    const m = await api(`/api/socialV2/memory?key=${encodeURIComponent(KEY)}`);
    if (!m || !m.raw) return false;
    fs.mkdirSync(MEMDIR, { recursive: true });
    const payload = { at: new Date().toISOString(), reason, key: KEY, raw: m.raw };
    fs.writeFileSync(path.join(MEMDIR, 'live.json'), JSON.stringify(payload, null, 2));
    if (reason !== 'periodic') {
      const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
      fs.writeFileSync(path.join(MEMDIR, `power-${day}.json`), JSON.stringify(payload, null, 2));
    }
    lastSnapshotAt = Date.now();
    log(`记忆已快照（${reason}）`);
    return true;
  } catch (e) {
    log('记忆快照失败:', e.message);
    return false;
  }
}

function runNode(script, args = []) {
  try {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    log(`${path.basename(script)} 退出码 ${r.status}`);
  } catch (e) {
    log(`${path.basename(script)} 失败:`, e.message);
  }
}

async function gracefulShutdown(pct) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`电量 ${pct.toFixed(0)}%，准备保存并关机`);
  await snapshot('power');
  runNode(path.join(ROOT, 'archive', 'collector.mjs'), ['--once']);
  runNode(path.join(ROOT, 'maintenance', 'maintenance.mjs'));
  try {
    fs.writeFileSync(path.join(MEMDIR, 'last-shutdown.json'), JSON.stringify({ at: new Date().toISOString(), pct, reason: 'power' }, null, 2));
  } catch {}
  if (DRY) { log('[dry-run] 不执行关机'); shuttingDown = false; return; }
  try {
    spawnSync('shutdown.exe', ['/s', '/t', '60', '/c', '电源即将耗尽：机器人已保存记忆，1 分钟后关机'], { windowsHide: true });
    log('已下达关机命令（60 秒后）');
  } catch (e) {
    log('关机命令失败:', e.message);
  }
}

async function tick() {
  const p = readPower();
  const now = Date.now();

  // 周期性热快照（防止直接断电）
  if (now - lastSnapshotAt > SNAPSHOT_MIN * 60000) await snapshot('periodic');

  if (p.error) { log('电源状态读取失败:', p.error); return; }
  if (p.online) {
    if (unpluggedAt) log('已接回电源，取消关机倒计时');
    unpluggedAt = 0;
    return;
  }

  if (!unpluggedAt) {
    unpluggedAt = now;
    log(`电源已断开（电量 ${p.pct.toFixed(0)}%），开始倒计时`);
  }
  const grace = p.pct < CRITICAL_PCT ? CRITICAL_GRACE_MIN : GRACE_MIN;
  const left = grace * 60000 - (now - unpluggedAt);
  if (left <= 0) {
    await gracefulShutdown(p.pct);
  } else if (Math.round(left / 1000) % 60 === 0) {
    log(`距关机还有 ${Math.round(left / 60000)} 分钟（电量 ${p.pct.toFixed(0)}%）`);
  }
}

log(`电源守门员启动：拔电 ${GRACE_MIN} 分钟后关机，电量<${CRITICAL_PCT}% 则 ${CRITICAL_GRACE_MIN} 分钟；热快照每 ${SNAPSHOT_MIN} 分钟`);
await tick();
setInterval(() => void tick().catch((e) => log('检查出错:', e.message)), 60000);
