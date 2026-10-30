#!/usr/bin/env node
/**
 * mouth —— 嘴：默认闭着，只负责把「谁死了、谁摸鱼、谁能干活」通报给主脑。
 *
 * 为什么要有嘴：眼只上报给急救员（救命用），急救员又只在主脑不在时才接管。
 * 主脑自己不知道别的东西活得怎么样 —— 它只看到自己那 9 个 worker 和三个脑的返回值，
 * 看不到「眼是不是还活着」「急救员有没有在跑」「哪个脑已经自己下线十分钟没恢复」。
 * 所以让嘴定期把全场汇总成一张表塞给主脑，主脑据此决定要不要动手。
 *
 * 嘴不动手、不重启、不删东西，也不主动叫醒谁（叫醒是急救员的活）。
 * 默认静默：只有「名单变了」（谁死/谁摸鱼）才写一行日志，其余时间只更新 state/mouth-report.json。
 *
 * 用法：node mouth/mouth.mjs          （开机由 QQBotMouth 任务拉起）
 *       node mouth/mouth.mjs --status
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE, stamp } from '../lib/base.mjs';

const MOUTH_LOCK = path.join(STATE, 'mouth.lock');
const MOUTH_STATE = path.join(STATE, 'mouth.json');
const MOUTH_REPORT = path.join(STATE, 'mouth-report.json');
const MOUTH_LOG = path.join(STATE, 'mouth.log');
const CHECK_MS = 30000;
const STATUS_ONLY = process.argv.includes('--status');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function readPid(p) { try { return Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch { return 0; } }
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function log(msg) { try { fs.appendFileSync(MOUTH_LOG, `[${stamp()}] ${msg}\n`); } catch {} }

/** 最近一次决策是什么时候（判断主脑是不是「活着但不出声」） */
function lastDecisionAt() {
  try {
    const lines = fs.readFileSync(path.join(STATE, 'brain-decisions.jsonl'), 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    return Date.parse(last.at) || 0;
  } catch { return 0; }
}

function inspect() {
  const now = Date.now();
  const brainPid = readPid(path.join(STATE, 'brain.lock'));
  const bj = readJson(path.join(STATE, 'brain.json'));
  const brainAge = bj && bj.at ? now - Date.parse(bj.at) : -1;
  const brainAlive = pidAlive(brainPid) && brainAge >= 0 && brainAge < 150000;

  const dead = [];
  const idle = [];
  const who = {};

  // 主脑
  who.brain = { alive: brainAlive, pid: brainPid, ageSec: brainAge < 0 ? null : Math.round(brainAge / 1000) };
  if (!brainAlive) dead.push('brain');

  // 三脑（在主脑进程里，主脑不在就一起算死）
  const h = (bj && bj.hemis) || {};
  for (const name of ['left', 'right', 'cerebellum']) {
    const s = h[name] || {};
    who[name] = { status: s.status || 'unknown', offlineSec: s.offlineSec || 0, errors: s.errors || 0, violations: s.violations || 0 };
    if (!brainAlive) dead.push(name);
    else if (s.status === 'offline') {
      dead.push(name);
      if ((s.offlineSec || 0) > 600) idle.push(`${name} 下线超过 10 分钟`);
    }
  }

  // 器官：眼 / 急救员 / 嘴自己
  for (const [name, file] of [['eye', 'eye.lock'], ['medic', 'medic.lock'], ['mouth', 'mouth.lock']]) {
    const pid = readPid(path.join(STATE, file));
    const alive = pidAlive(pid);
    who[name] = { alive, pid };
    if (!alive && name !== 'mouth') dead.push(name);
  }

  // worker：谁能干活
  const ws = Array.isArray(bj && bj.workers) ? bj.workers : [];
  const running = ws.filter((w) => w.alive).length;
  const stale = ws.filter((w) => w.alive && w.lockAgeSec > 180).map((w) => w.name);
  const quarantined = ws.filter((w) => w.quarantineSec > 0).map((w) => w.name);
  const broken = ws.filter((w) => w.broken).map((w) => w.name);
  who.workers = { running, total: ws.length, stale, quarantined, broken };
  for (const n of stale) idle.push(`worker ${n} 锁僵住`);
  for (const n of quarantined) idle.push(`worker ${n} 在隔离`);

  // 左右手（看最近 24 小时有没有真的干过活；没活干不算摸鱼，长期没输出才算）
  let decisions = [];
  try {
    decisions = fs.readFileSync(path.join(STATE, 'brain-decisions.jsonl'), 'utf8').trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}
  const dayAgo = now - 86400000;
  const handWork = decisions.filter((d) => Date.parse(d.at) > dayAgo && /左手|右手/.test(d.rule)).length;
  who.hands = { worked24h: handWork };

  // 主脑「活着但不出声」= 摸鱼
  const lastDec = lastDecisionAt();
  who.brain.lastDecisionAgeSec = lastDec ? Math.round((now - lastDec) / 1000) : null;
  if (brainAlive && lastDec && now - lastDec > 6 * 3600000) idle.push('主脑 6 小时没做过任何决策');

  const canWork = brainAlive && who.workers.running > 0;
  return {
    at: new Date(now).toISOString(),
    pid: process.pid,
    canWork,
    dead,
    idle,
    who,
    summary: `主脑${brainAlive ? '在' : '不在'}，worker ${running}/${ws.length} 能干活，死：${dead.length ? dead.join('/') : '无'}，摸鱼：${idle.length ? idle.join('/') : '无'}`,
  };
}

function printStatus() {
  const s = readJson(MOUTH_STATE);
  if (!s) { console.log('嘴还没跑过'); return; }
  console.log(`嘴 pid=${s.pid}  更新于 ${new Date(s.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log(`  ${s.summary}`);
  console.log(`  能不能干活：${s.canWork ? '能' : '不能'}`);
}

async function main() {
  if (STATUS_ONLY) { printStatus(); return; }
  const old = readPid(MOUTH_LOCK);
  if (old && old !== process.pid && pidAlive(old)) { console.log('嘴已在跑'); process.exit(3); }
  try { fs.writeFileSync(MOUTH_LOCK, String(process.pid)); } catch {}
  const beat = setInterval(() => { try { fs.writeFileSync(MOUTH_LOCK, String(process.pid)); } catch {} }, 20000);
  beat.unref?.();
  process.on('exit', () => { try { if (readPid(MOUTH_LOCK) === process.pid) fs.unlinkSync(MOUTH_LOCK); } catch {} });

  log('嘴上岗（默认闭着，只在名单变化时写一行）');
  let lastSig = '';
  const tick = () => {
    try {
      const r = inspect();
      try {
        fs.mkdirSync(STATE, { recursive: true });
        fs.writeFileSync(MOUTH_STATE, JSON.stringify(r, null, 2));
        // 给主脑看的那一份：只放它需要知道的
        fs.writeFileSync(MOUTH_REPORT, JSON.stringify({
          at: r.at,
          canWork: r.canWork,
          dead: r.dead,
          idle: r.idle,
          workers: r.who.workers,
          hemis: { left: r.who.left, right: r.who.right, cerebellum: r.who.cerebellum },
          organs: { eye: r.who.eye, medic: r.who.medic, hands: r.who.hands },
          summary: r.summary,
        }, null, 2));
      } catch {}
      const sig = `${r.dead.join(',')}|${r.idle.join(',')}|${r.canWork}`;
      if (sig !== lastSig) {
        lastSig = sig;
        log(`口报：${r.summary}`);
      }
    } catch (e) { log('嘴出错：' + e.message); }
  };
  tick();
  setInterval(tick, CHECK_MS);
}

await main();
