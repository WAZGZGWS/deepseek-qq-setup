#!/usr/bin/env node
/**
 * clock —— 生物钟：什么时候该安静、什么时候该冒头。
 *
 * 以前「作息」散在三处：silence-schedule（定时静默）、余额档位（省聊）、cron（早安晚安）。
 * 结果是互相打架：余额说可以主动、静默说别说话、早上又说该问好了。
 * 这里按北京时间把一天切成四段，只在一段**变的时候**去调桥接的主动发言参数：
 *
 *   23:00–07:00  夜里    : 关主动，回复也短（他睡了）
 *   07:00–09:00  早上    : 轻主动（问好、报天气）
 *   09:00–18:00  上班    : 关主动（他在忙），但他说话照常回
 *   18:00–23:00  晚上    : 正常主动（他下班了，愿意聊）
 *
 * 判据只有小时，不猜他在干嘛；一天最多改 4 次，不刷桥接配置。
 *
 * 用法：node clock/clock.mjs  |  --status  |  --once
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE, stamp } from '../lib/base.mjs';

const NAME = 'clock';
const LOCK = path.join(STATE, `${NAME}.lock`);
const OUT = path.join(STATE, 'clock.json');
const LOG = path.join(STATE, 'clock.log');
const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');
const TICK_MS = 5 * 60 * 1000;

const ONCE = process.argv.includes('--once');
const STATUS_ONLY = process.argv.includes('--status');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function readPid(p) { try { return Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch { return 0; } }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function log(msg) { const line = `[${stamp()}] ${msg}`; try { fs.appendFileSync(LOG, line + '\n'); } catch {} console.log(line); }

const PHASES = [
  {
    id: 'night', from: 23, to: 7, label: '夜里', quiet: true,
    patch: { proactive: { enabled: false }, send: { burstMaxMessages: 2, maxMessageChars: 200 } },
  },
  {
    id: 'morning', from: 7, to: 9, label: '早上', quiet: false,
    patch: {
      proactive: { enabled: true, probability: 0.2, checkIntervalMinMs: 3600000, checkIntervalMaxMs: 7200000, idleThresholdMs: 1800000 },
      send: { burstMaxMessages: 4, maxMessageChars: 400 },
    },
  },
  {
    id: 'work', from: 9, to: 18, label: '上班时间', quiet: false,
    patch: { proactive: { enabled: false } },
  },
  {
    id: 'evening', from: 18, to: 23, label: '晚上', quiet: false,
    patch: {
      proactive: { enabled: true, probability: 0.3, checkIntervalMinMs: 2700000, checkIntervalMaxMs: 5400000, idleThresholdMs: 1500000 },
      send: { burstMaxMessages: 6, maxMessageChars: 500 },
    },
  },
];

function phaseAt(now = new Date()) {
  const h = Number(now.toLocaleString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }));
  return PHASES.find((p) => (p.from < p.to ? h >= p.from && h < p.to : h >= p.from || h < p.to)) || PHASES[0];
}

function token() {
  try { return fs.readFileSync(path.join(BRIDGE, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

async function apply(phase) {
  const t = token();
  if (!t) { log('拿不到 console-token，跳过'); return false; }
  try {
    const r = await fetch('http://127.0.0.1:3100/api/socialV2/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': t },
      body: JSON.stringify(phase.patch),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return true;
  } catch (e) { log(`切到「${phase.label}」失败：${e.message}`); return false; }
}

async function tick() {
  const phase = phaseAt();
  const st = readJson(OUT) || {};
  const now = Date.now();
  if (st.phase !== phase.id) {
    const ok = await apply(phase);
    fs.writeFileSync(OUT, JSON.stringify({ at: new Date(now).toISOString(), phase: phase.id, label: phase.label, quiet: phase.quiet, applied: ok, since: new Date(now).toISOString() }, null, 2));
    if (ok) log(`进入「${phase.label}」（${phase.quiet ? '安静' : '可以冒头'}）`);
  } else if (!st.at || now - Date.parse(st.at) > 60 * 60 * 1000) {
    st.at = new Date(now).toISOString();
    fs.writeFileSync(OUT, JSON.stringify(st, null, 2));
  }
  return phase;
}

function printStatus() {
  const st = readJson(OUT) || {};
  const p = phaseAt();
  console.log(`生物钟：现在「${p.label}」${p.quiet ? '（安静）' : ''}，上次切换 ${st.since ? new Date(st.since).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '还没切过'}`);
  console.log(`  四段：夜间 23–7 关主动 / 早上 7–9 轻主动 / 上班 9–18 关主动 / 晚上 18–23 正常`);
}

async function main() {
  if (STATUS_ONLY) { printStatus(); return; }
  if (ONCE) { await tick(); printStatus(); return; }
  const old = readPid(LOCK);
  if (old && old !== process.pid && pidAlive(old)) { console.log('生物钟已有实例在跑'); process.exit(3); }
  fs.writeFileSync(LOCK, String(process.pid));
  const beat = setInterval(() => { try { fs.writeFileSync(LOCK, String(process.pid)); } catch {} }, 20000);
  beat.unref?.();
  process.on('exit', () => { try { if (readPid(LOCK) === process.pid) fs.unlinkSync(LOCK); } catch {} });

  for (;;) {
    try { await tick(); } catch (e) { log('生物钟出错：' + e.message); }
    await sleep(TICK_MS);
  }
}

main();
