#!/usr/bin/env node
import { singleInstance } from '../lock/single.mjs';
singleInstance('peak');
/**
 * peak-watch —— 高峰时段提醒「省着点说」
 *
 * 背景：DeepSeek 有优惠时段（北京时间 00:30~08:30 半价，推理模型更便宜）。
 * 白天和晚上是全价，同样聊一句，钱是夜里的一倍。
 * 哥要的是：**在高价时段，花得有点猛的时候提醒他一句**，别不知不觉烧掉一天的量。
 *
 * 做法（每 10 分钟一次，不花 token）：
 *   1. 从 token-usage.jsonl 算今天花了多少（和 budget-guard 用同一套价目）
 *   2. 只在高峰时段（默认 08:30~23:30）提醒；优惠时段和半夜都不打扰
 *   3. 花费每多花一档（默认 1.5 元）提醒一次，两次之间至少隔 2 小时，一天最多 4 次
 *   4. 提醒直接走 NapCat 发私聊，不经过模型 —— 提醒本身不烧钱
 *
 * 环境变量：PEAK_FROM / PEAK_TO（默认 08:30 / 23:30，半夜不打扰）
 *          PEAK_STEP（每多花几元提醒一次，默认 1.5）
 *          PEAK_COOLDOWN_MIN（两次间隔，默认 120）
 *          PEAK_MAX_PER_DAY（一天最多几次，默认 4）
 *          PEAK_CHECK_MIN（检查间隔，默认 10）
 *          DRY_RUN=1 只打印不发送
 *
 * 用法：node peak-watch.mjs          正常跑
 *       node peak-watch.mjs --dry    只算不发
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE, stamp, ownerQQ, costOf, readJson } from '../lib/base.mjs';

const DRY = process.argv.includes('--dry') || process.env.DRY_RUN === '1';
const MINE = path.join(STATE, 'peak-watch.json');
const LOG_FILE = path.join(STATE, 'peak-watch.log');
const USAGE = path.join(STATE, 'token-usage.jsonl');

const PEAK_FROM = process.env.PEAK_FROM || '08:30';
const PEAK_TO = process.env.PEAK_TO || '23:30';
const STEP = Number(process.env.PEAK_STEP || 1.5);
const START_AT = Number(process.env.PEAK_START_AT || 2);
const COOLDOWN_MIN = Math.max(30, Number(process.env.PEAK_COOLDOWN_MIN || 120));
const MAX_PER_DAY = Math.max(1, Number(process.env.PEAK_MAX_PER_DAY || 4));
const CHECK_MIN = Math.max(2, Number(process.env.PEAK_CHECK_MIN || 10));

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  try { console.log(line); } catch {}
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

/** 现在是不是高峰（全价）时段。区间跨午夜也能处理 */
function inPeak(now = new Date()) {
  const hm = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 5);
  const toMin = (s) => {
    const [h, m] = String(s).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const cur = toMin(hm);
  const from = toMin(PEAK_FROM);
  const to = toMin(PEAK_TO);
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}

/** 今天花了多少（和 budget-guard 同一套算法） */
function spendToday() {
  let rows = [];
  try {
    rows = fs.readFileSync(USAGE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return 0; }
  const d = today();
  let cost = 0;
  for (const r of rows) {
    if (r.k !== 'turn') continue;
    if (new Date(r.t).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) !== d) continue;
    cost += costOf(r.b || {});
  }
  return cost;
}

async function sendQQ(text) {
  const uid = ownerQQ();
  if (!uid) { log('读不到 ownerQQ，跳过'); return false; }
  if (DRY) { log('[dry-run] 会发：' + text); return true; }
  try {
    const r = await fetch('http://127.0.0.1:3000/send_private_msg', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: uid, message: text }),
      signal: AbortSignal.timeout(12000),
    });
    const j = await r.json();
    if (j?.status === 'ok' && (j?.retcode === 0 || j?.retcode === undefined)) return true;
    log('发送失败：' + JSON.stringify(j).slice(0, 160));
    return false;
  } catch (e) {
    log('发送异常：' + e.message);
    return false;
  }
}

function text(spend) {
  return `哥，这会儿是全价时段，同样的聊法比夜里贵一倍。今天已经 ${spend.toFixed(1)} 块了，能省就省着点说，我陪你少说两句也一样`;
}

async function tick() {
  const st = readJson(MINE, {});
  const day = today();
  let sent = st.day === day ? Number(st.sent || 0) : 0;
  let nextAt = st.day === day ? Number(st.nextAt || 0) : 0;
  let lastAt = st.day === day ? Number(st.lastAt || 0) : 0;

  // 新的一天：初始门槛 = max(起点, 当前花费 + 一档)，避免一上来就念
  if (st.day !== day) {
    nextAt = Math.max(START_AT, spendToday() + STEP);
    fs.writeFileSync(MINE, JSON.stringify({ day, nextAt, lastAt: 0, sent: 0 }, null, 2));
    return;
  }

  if (!inPeak()) return;                       // 优惠时段不打扰
  if (sent >= MAX_PER_DAY) return;
  if (Date.now() - lastAt < COOLDOWN_MIN * 60000) return;

  const spend = spendToday();
  if (spend < nextAt) return;

  const ok = await sendQQ(text(spend));
  if (ok) {
    sent += 1;
    lastAt = Date.now();
    nextAt = spend + STEP;
    log(`已提醒（第 ${sent} 次）：今天 ${spend.toFixed(2)} 元，下次门槛 ${nextAt.toFixed(2)} 元`);
  }
  try { fs.writeFileSync(MINE, JSON.stringify({ day, nextAt, lastAt, sent }, null, 2)); } catch {}
}

log(`启动：高峰 ${PEAK_FROM}~${PEAK_TO}，每多花 ${STEP} 元提醒一次，间隔 ≥${COOLDOWN_MIN} 分钟，一天最多 ${MAX_PER_DAY} 次${DRY ? ' [DRY-RUN]' : ''}`);
await tick().catch((e) => log('异常: ' + e.message));
setInterval(() => void tick().catch((e) => log('异常: ' + e.message)), CHECK_MIN * 60000);
