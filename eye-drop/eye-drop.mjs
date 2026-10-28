#!/usr/bin/env node
import { singleInstance } from '../lock/single.mjs';
singleInstance('eye-drop');
/**
 * eye-drop —— 滴眼药水提醒，按「哥今天什么时候醒」来排，不再定死在 7:00
 *
 * 为什么改：原来三条任务写死 07:05 / 07:10 / 07:15。要是哥那天 9 点才醒，
 * 三条全在他还没睁眼的时候发完了，等于没提醒。
 *
 * 现在的逻辑：
 *   1. 每分钟看一眼今天的聊天档案，找出「哥今天发的第一句话」是几点
 *   2. 只认 04:00~12:00 之间的第一句（更晚不算赖床，是不需要提醒了）
 *   3. 那一刻 +2 / +7 / +12 分钟，分别建一条一次性的 AI 提醒任务
 *   4. 一天只排一次；排完记在 state/eye-drop.json
 *
 * 为什么用「一次性任务」而不是改固定任务的时间：
 *   固定任务每天都会在同一个点响。今天按 8:12 排，明天 8:12 就会先响一次，
 *   而那时哥可能还没醒。一次性任务只用一天，第二天重新按当天的醒来时间排。
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');
const STATE = path.join(BRIDGE, 'state');
const MINE = path.join(ROOT, 'state', 'eye-drop.json');
const LOG = path.join(ROOT, 'state', 'eye-drop.log');
const ARCHIVE = path.join(ROOT, 'archive', 'logs');

const CHECK_MS = 60 * 1000;
const OFFSETS_MIN = (process.env.EYE_DROP_OFFSETS || '2,7,12').split(',').map(Number).filter((n) => Number.isFinite(n));
const WAKE_FROM = Number(process.env.EYE_DROP_FROM_HOUR || 4);   // 早于 4 点不算"醒了"
const WAKE_TO = Number(process.env.EYE_DROP_TO_HOUR || 12);     // 晚于 12 点不再提醒

function stamp() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    try {
      if (fs.statSync(LOG).size > 256 * 1024) fs.renameSync(LOG, LOG + '.1');
    } catch {}
    fs.appendFileSync(LOG, line + '\n');
  } catch {}
  try { console.log(line); } catch {}
}
function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}
function token() {
  try { return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim(); } catch { return ''; }
}
async function api(p, options = {}) {
  const r = await fetch(`http://127.0.0.1:3100${p}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-console-token': token() },
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
}
function readState() {
  try { return JSON.parse(fs.readFileSync(MINE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(MINE), { recursive: true });
    fs.writeFileSync(MINE, JSON.stringify(s, null, 2));
  } catch {}
}
function ownerQQ() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(BRIDGE, 'config.json'), 'utf8'));
    return Number(c.ownerQQ) || 0;
  } catch { return 0; }
}

/** 机器人自己的昵称，用来区分"谁说的" */
async function botNickname() {
  try {
    const r = await fetch('http://127.0.0.1:3000/get_login_info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(6000),
    });
    const j = await r.json();
    return String(j?.data?.nickname || '');
  } catch {
    return '';
  }
}

/** 今天「哥」发的第一句话是几点（HH:MM），没有就返回 null */
function firstOwnerMessageToday(botNick) {
  const file = path.join(ARCHIVE, `${today()}.md`);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    const m = line.match(/^-\s*(\d{2}):(\d{2})\s+\*\*(.+?)\*\*/);
    if (!m) continue;
    if (botNick && m[3] === botNick) continue;   // 自己说的，跳过
    return { hh: Number(m[1]), mm: Number(m[2]), nick: m[3] };
  }
  return null;
}

function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function arm(wakeAt) {
  const uid = ownerQQ();
  if (!uid) { log('读不到 ownerQQ，跳过'); return; }
  const day = today();
  const created = [];
  const recipes = [
    { name: '滴眼药水1', offset: OFFSETS_MIN[0] ?? 2, instruction: '提醒哥滴眼药水。随口一句，别像医嘱。' },
    { name: '滴眼药水2', offset: OFFSETS_MIN[1] ?? 7, instruction: '再提一次滴眼药水。换个说法，别重复上一句原话。' },
    { name: '滴眼药水3', offset: OFFSETS_MIN[2] ?? 12, instruction: '最后一次提滴眼药水。他要说已经滴了就别再念了。' },
  ];
  for (const r of recipes) {
    const at = new Date(wakeAt.getTime() + r.offset * 60 * 1000);
    const body = JSON.stringify({
      name: `${r.name}（${day}）`,
      kind: 'ai',
      instruction: r.instruction,
      targets: [`private:${uid}`],
      schedule: { type: 'once', date: day, time: hhmm(at) },
      maxRuns: 1,
      runDuringSilence: true,
    });
    const res = await api('/api/scheduler/tasks', { method: 'POST', body });
    if (res.body?.ok && res.body.task?.id) {
      created.push({ id: res.body.task.id, at: hhmm(at) });
      log(`已排 ${r.name} → ${hhmm(at)}`);
    } else {
      log(`排 ${r.name} 失败：${JSON.stringify(res.body).slice(0, 160)}`);
    }
  }
  return created;
}

async function tick() {
  const st = readState();
  const day = today();
  if (st.lastDay === day) return;         // 今天已经排过

  const nick = await botNickname();
  const first = firstOwnerMessageToday(nick);
  if (!first) {
    // 过了中午还没有"哥的第一句话"：要么他今天真的没说话，要么档案收集器只记了一方
    const hour = Number(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 2));
    if (hour >= 12 && !st.warnedNoOwner) {
      log('到今天中午为止，档案里都没有哥说的话 —— 如果今天其实聊过，就是档案收集器又只记一方了（跑一次 self-check 确认）');
      writeState({ ...st, warnedNoOwner: true });
    }
    return;                                // 哥今天还没说话
  }

  if (first.hh < WAKE_FROM || first.hh >= WAKE_TO) {
    // 不是早晨醒来的时间，今天不提醒（避免晚上 11 点突然叫滴眼药水）
    writeState({ ...st, lastDay: day, skipped: `${first.hh}:${String(first.mm).padStart(2, '0')}`, reason: '不在早晨窗口' });
    return;
  }

  const wakeAt = new Date();
  wakeAt.setHours(first.hh, first.mm, 0, 0);
  log(`哥今天第一句是 ${hhmm(wakeAt)}，按这个时间排三条提醒`);

  const created = await arm(wakeAt);
  writeState({ lastDay: day, wakeAt: wakeAt.toISOString(), tasks: created });
  log(created.length ? `完成，排了 ${created.length} 条` : '一条也没排上（看上面的失败原因）');
}

log(`启动：每 ${CHECK_MS / 1000}s 检查一次，醒来窗口 ${WAKE_FROM}:00~${WAKE_TO}:00，提醒偏移 ${OFFSETS_MIN.join('/')} 分钟`);
await tick().catch((e) => log('异常: ' + e.message));
setInterval(() => void tick().catch((e) => log('异常: ' + e.message)), CHECK_MS);
