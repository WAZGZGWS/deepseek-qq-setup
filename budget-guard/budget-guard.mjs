#!/usr/bin/env node
import { singleInstance } from '../lock/single.mjs';
singleInstance('budget');
/**
 * budget-guard —— 每日预算护栏
 *
 * 每 30 分钟算一次今天的 DeepSeek 花费（从 token-usage.jsonl 估算）。
 * 超过日预算（默认 2 元）→ 进入「省电模式」：
 *   · 用桥接的静默配置挡住主动唤醒和定时任务
 *   · 你私聊她仍然会回（includeOwnerPrivate=false）
 *   · 给你发一条 QQ 说明
 * 第二天花费回到预算内 → 自动恢复「只在夜间静默」。
 *
 * 环境变量：DAILY_BUDGET（默认 5）、CHECK_MIN（默认 30）
 */
import fs from 'node:fs';
import path from 'node:path';
import { STATE, stamp, today, PRICE, ownerQQ, consoleApi as api } from '../lib/base.mjs';

// 主人的 QQ 号从桥接 config.json 里读 —— 下载的人不用手改这里
const OWNER = ownerQQ();
const BUDGET = Number(process.env.DAILY_BUDGET || 5);
const CHECK_MIN = Math.max(5, Number(process.env.CHECK_MIN || 30));

const NORMAL_SILENCE = {
  enabled: true,
  timezone: 'Asia/Shanghai',
  ranges: [{ id: 'night', name: '夜间静默', enabled: true, start: '00:30', end: '07:00', days: 'daily', weekdays: [], skipHolidays: false }],
  options: { stopWakes: true, recordMessages: true, pauseAiTasks: false, includeOwnerPrivate: false, catchUpOnEnd: true },
};
const BUDGET_SILENCE = {
  enabled: true,
  timezone: 'Asia/Shanghai',
  ranges: [{ id: 'budget', name: '预算保护', enabled: true, start: '00:00', end: '23:59', days: 'daily', weekdays: [], skipHolidays: false }],
  options: { stopWakes: true, recordMessages: true, pauseAiTasks: true, includeOwnerPrivate: false, catchUpOnEnd: false },
};

function log(...a) {
  const line = `[${stamp()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(STATE, 'budget.log'), line + '\n'); } catch {}
}

function spendToday() {
  const file = path.join(STATE, 'token-usage.jsonl');
  let rows = [];
  try {
    rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return 0; }
  let cost = 0;
  const d = today();
  for (const r of rows) {
    if (r.k !== 'turn') continue;
    if (new Date(r.t).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) !== d) continue;
    const b = r.b || {};
    cost += ((b.cacheHit || 0) / 1e6) * PRICE.cacheHit + ((b.cacheMiss || 0) / 1e6) * PRICE.cacheMiss + ((b.output || 0) / 1e6) * PRICE.output;
  }
  return cost;
}

async function notify(text) {
  if (!OWNER) return; // 没配 ownerQQ 就只写日志，不去撞 NapCat
  try {
    await fetch('http://127.0.0.1:3000/send_private_msg', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: OWNER, message: text }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    log('通知发送失败:', e.message);
  }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE, 'budget-state.json'), 'utf8')); } catch { return {}; }
}
function writeState(s) {
  try { fs.writeFileSync(path.join(STATE, 'budget-state.json'), JSON.stringify(s, null, 2)); } catch {}
}

async function tick() {
  const cost = spendToday();
  const st = readState();
  const d = today();
  const over = cost >= BUDGET;

  if (over && st.mode !== 'budget') {
    log(`今日花费 ${cost.toFixed(2)} 元，超预算 ${BUDGET} 元 → 进入省电模式`);
    await api('/api/silence', { method: 'POST', body: JSON.stringify(BUDGET_SILENCE) });
    writeState({ mode: 'budget', since: d, day: d, cost });
    return;
  }

  if (!over && st.mode === 'budget' && st.day !== d) {
    log(`新的一天，花费归零 → 恢复正常`);
    await api('/api/silence', { method: 'POST', body: JSON.stringify(NORMAL_SILENCE) });
    writeState({ mode: 'normal', day: d, cost });
    return;
  }

  writeState({ ...st, day: d, cost, mode: st.mode === 'budget' && over ? 'budget' : (over ? 'budget' : 'normal') });
}

log(`预算护栏启动：每天 ${BUDGET} 元 / 每 ${CHECK_MIN} 分钟检查`);
await tick();
setInterval(() => void tick().catch((e) => log('检查出错:', e.message)), CHECK_MIN * 60000);
