#!/usr/bin/env node
import { singleInstance } from '../lock/single.mjs';
// --selftest 只跑纯规则，不该被"已有实例在跑"挡掉（回归/排查时经常要一边跑一边测）
if (!process.argv.includes('--selftest')) singleInstance('eye-drop');
/**
 * eye-drop —— 滴眼药水提醒，按「哥今天什么时候醒」来排，不再定死在 7:00
 *
 * 为什么改：原来三条任务写死 07:05 / 07:10 / 07:15。要是哥那天 9 点才醒，
 * 三条全在他还没睁眼的时候发完了，等于没提醒。
 *
 * 现在的逻辑：
 *   1. 每分钟看一眼今天的聊天档案，找出「哥今天发的第一句话」是几点
 *   2. 只认 04:00~12:00 之间的第一句（更晚不算赖床，是不需要提醒了）
 *   3. 那一刻 +2 / +10 分钟，各建一条一次性的 AI 提醒任务
 *   4. 一天只排一次；排完记在 state/eye-drop.json
 *
 * ★ 做完就闭嘴（2026-10-28 加的）：
 *   哥说「早就滴了 / 干完了 / 弄过了」之后，**剩下没响的提醒全部撤掉**，
 *   并且当天不再补排。以前是三条雷打不动地响，他明明做完了还被念三遍。
 *   每分钟查一次档案，认出来就 DELETE 掉 scheduler 里还没执行的任务。
 *
 * 为什么用「一次性任务」而不是改固定任务的时间：
 *   固定任务每天都会在同一个点响。今天按 8:12 排，明天 8:12 就会先响一次，
 *   而那时哥可能还没醒。一次性任务只用一天，第二天重新按当天的醒来时间排。
 *
 * 用法：node eye-drop.mjs           正常跑
 *       node eye-drop.mjs --dry     只算不写（看今天会不会排、排几点）
 *       node eye-drop.mjs --selftest  只测「认出做完了没」那套规则
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, BRIDGE, stamp, consoleApi as api } from '../lib/base.mjs';

const MINE = path.join(ROOT, 'state', 'eye-drop.json');
const LOG = path.join(ROOT, 'state', 'eye-drop.log');
const ARCHIVE = path.join(ROOT, 'archive', 'logs');

const DRY = process.argv.includes('--dry');
const SELFTEST = process.argv.includes('--selftest');
const CHECK_MS = 60 * 1000;
// 从三条减到两条：做完了会被撤掉，没做完两条也够了，三条太念
const OFFSETS_MIN = (process.env.EYE_DROP_OFFSETS || '2,10').split(',').map(Number).filter((n) => Number.isFinite(n));
const WAKE_FROM = Number(process.env.EYE_DROP_FROM_HOUR || 4);   // 早于 4 点不算"醒了"
const WAKE_TO = Number(process.env.EYE_DROP_TO_HOUR || 12);     // 晚于 12 点不再提醒

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
function readState() {
  try { return JSON.parse(fs.readFileSync(MINE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  if (DRY) return;
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

/**
 * 这段话是不是在说「我已经弄完了」。
 *
 * 只认明确的完成信号，而且必须跟「滴 / 眼药水」沾边 ——
 * 不然「活干完了」也会被当成滴过了，那当天就不提醒了。
 */
const DONE_WORDS = /(滴了|滴过|滴完|滴好啦|滴上了|已经滴|早滴|弄完|弄过|干完|做完|搞定|完事)/;
const DROP_WORDS = /(滴|眼药|点眼|药水)/;
const NEGATIVE = /(没滴|没有滴|还没|忘了|忘记|不滴|等下|一会|回头|待会)/;

function isDoneText(text) {
  const t = String(text || '');
  if (!t) return false;
  if (!DROP_WORDS.test(t)) return false;
  if (NEGATIVE.test(t)) return false;
  return DONE_WORDS.test(t);
}

/** 从今天的档案里找「哥说自己已经滴完了」，返回那一条（含时间）或 null */
function findDoneInLines(lines, botNick) {
  const parsed = [];
  for (const line of lines) {
    const m = line.match(/^-\s*(\d{2}):(\d{2})\s+\*\*(.+?)\*\*：(.*)$/);
    if (!m) continue;
    parsed.push({ at: `${m[1]}:${m[2]}`, who: m[3], text: m[4], min: Number(m[1]) * 60 + Number(m[2]) });
  }
  for (let i = parsed.length - 1; i >= 0; i--) {
    const cur = parsed[i];
    if (botNick && cur.who === botNick) continue;      // 她自己说的不算
    if (isDoneText(cur.text)) return { at: cur.at, text: cur.text, via: '直接说了' };

    // 语境判断：他这句本身没提眼药水，但上一两句是她在催、时间又挨着 —— 那就是在应她
    if (!DONE_WORDS.test(cur.text) || NEGATIVE.test(cur.text)) continue;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const p = parsed[j];
      if (botNick && p.who !== botNick) continue;
      if (!DROP_WORDS.test(p.text)) break;
      const gap = cur.min - p.min;
      if (gap >= 0 && gap <= 15) return { at: cur.at, text: cur.text, via: `在回她那句「${p.text.slice(0, 14)}…」` };
      break;
    }
  }
  return null;
}

function findDoneSignal(botNick) {
  const file = path.join(ARCHIVE, `${today()}.md`);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  return findDoneInLines(text.split('\n'), botNick);
}

function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function arm(wakeAt) {
  const uid = ownerQQ();
  if (!uid) { log('读不到 ownerQQ，跳过'); return []; }
  const day = today();
  const created = [];
  const guard = '先说一句：先看最近几句聊天——他今天要是已经说过滴过/做完了，就只回一句别的，别再提眼药水。';
  const recipes = [
    { name: '滴眼药水1', offset: OFFSETS_MIN[0] ?? 2, instruction: `${guard} 否则提醒哥滴眼药水，随口一句，别像医嘱。` },
    { name: '滴眼药水2', offset: OFFSETS_MIN[1] ?? 10, instruction: `${guard} 否则再提一次滴眼药水，换个说法，别重复上一句原话；他要是应了也别追问。` },
  ];
  for (const r of recipes) {
    let at = new Date(wakeAt.getTime() + r.offset * 60 * 1000);
    // 醒来时间是靠「他今天第一句话」推的，可能推得很晚：机器睡到 08:26 才跑这一轮，
    // 算出来的 08:18 早就过去了，桥接会直接回「这个时间已经过去了」，一条都排不上
    // （2026-10-29 就整天空转）。过点了就顺延到 1 分钟后，别整天不提醒。
    if (at.getTime() <= Date.now() + 30 * 1000) {
      const next = new Date(Date.now() + 60 * 1000);
      log(`${r.name} 原定 ${hhmm(at)} 已经过去了（识别得晚），改到 ${hhmm(next)}`);
      at = next;
    }
    if (DRY) { log(`[dry-run] 会排 ${r.name} → ${hhmm(at)}`); created.push({ id: `dry-${r.name}`, at: hhmm(at) }); continue; }
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

/** 把还没响的提醒撤掉（已经执行过的 DELETE 会报错，忽略即可） */
async function cancelPending(tasks) {
  let gone = 0;
  for (const t of tasks || []) {
    if (!t?.id) continue;
    const res = await api(`/api/scheduler/tasks/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
    if (res.body?.ok) gone += 1;
  }
  return gone;
}

async function tick() {
  const st = readState();
  const day = today();

  // 今天已经排过：只做一件事 —— 盯着他有没有说"弄完了"，说了就把剩下的撤掉
  if (st.lastDay === day) {
    if (st.doneAt) return;
    const done = findDoneSignal(await botNickname());
    if (!done) return;
    const pending = (st.tasks || []).filter((t) => !(st.firedNow || []).includes(t.id));
    const gone = await cancelPending(pending);
    writeState({ ...st, doneAt: done.at, doneText: done.text, canceled: gone });
    log(`哥 ${done.at} 说「${done.text}」——撤掉还没响的 ${gone} 条提醒，今天不再提`);
    return;
  }

  const nick = await botNickname();

  // 排之前先看：他是不是早就说过了（比如一早就弄完了）
  const doneAlready = findDoneSignal(nick);
  if (doneAlready) {
    writeState({ lastDay: day, doneAt: doneAlready.at, doneText: doneAlready.text, tasks: [] });
    log(`哥 ${doneAlready.at} 已经说「${doneAlready.text}」了，今天不排提醒`);
    return;
  }

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
  log(`哥今天第一句是 ${hhmm(wakeAt)}，按这个时间排 ${OFFSETS_MIN.length} 条提醒`);

  const created = await arm(wakeAt);
  writeState({ lastDay: day, wakeAt: wakeAt.toISOString(), tasks: created });
  log(created.length ? `完成，排了 ${created.length} 条（他做完会说，剩下的会被撤掉）` : '一条也没排上（看上面的失败原因）');
}

// ── 自测：只测「做完了没」这套判断，不碰网络 ────────────────────────
function selftest() {
  const cases = [
    ['早就滴过了，不用催', true],
    ['滴完了，刚滴的', true],
    ['我干完了，别念了', false],      // 没提眼药水，不算
    ['眼药水我弄完了', true],
    ['还没滴，等会儿', false],
    ['忘了滴了', false],
    ['眼药水在哪', false],
    ['嗯，滴了', true],
    ['活干完了', false],
    ['眼药水滴好啦', true],
  ];
  let bad = 0;
  for (const [text, want] of cases) {
    const got = isDoneText(text);
    if (got !== want) { bad += 1; console.log(`✗ 「${text}」期望 ${want}，实际 ${got}`); }
  }

  // 语境判断：他这句没提眼药水，但那是在回她的提醒
  const ctxLines = [
    '- 11:33 **机器人**：行啊哥，吃完了才特意发给我看，那眼药水滴了没',
    '- 11:34 **哥**：早就干完的事儿了，没必要重复吧？',
  ];
  if (!findDoneInLines(ctxLines, '机器人')) { bad += 1; console.log('✗ 语境判断失败：回了提醒却没认出来'); }

  const notDone = [
    '- 11:33 **机器人**：那眼药水滴了没',
    '- 11:34 **哥**：还没，等会儿',
  ];
  if (findDoneInLines(notDone, '机器人')) { bad += 1; console.log('✗ 误判：明明说还没滴'); }

  const unrelated = [
    '- 11:33 **机器人**：今天中午吃啥',
    '- 11:34 **哥**：活干完了，下班',
  ];
  if (findDoneInLines(unrelated, '机器人')) { bad += 1; console.log('✗ 误判：说的是干活不是滴药'); }

  console.log(bad ? `自测失败 ${bad} 条` : `自测通过（${cases.length} 条 + 3 个语境用例）`);
  if (bad) process.exitCode = 1;
}

if (SELFTEST) {
  selftest();
} else {
  log(`启动：每 ${CHECK_MS / 1000}s 检查一次，醒来窗口 ${WAKE_FROM}:00~${WAKE_TO}:00，提醒偏移 ${OFFSETS_MIN.join('/')} 分钟${DRY ? ' [DRY-RUN]' : ''}`);
  await tick().catch((e) => log('异常: ' + e.message));
  setInterval(() => void tick().catch((e) => log('异常: ' + e.message)), CHECK_MS);
}
