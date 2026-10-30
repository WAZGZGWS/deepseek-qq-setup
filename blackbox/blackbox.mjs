#!/usr/bin/env node
/**
 * blackbox —— 黑匣子：一直录，只在出事时说话。
 *
 * 为什么要有它：2026-10-30 她掉了 8 小时，事后能查到的只有「档案里有一段空白」。
 * 谁先动的手、端口什么时候断的、有没有两个东西在互相踩，全靠回忆 —— 这就是缺黑匣子。
 *
 * 它每 10 秒录一条快照（端口、主脑、三脑、worker、器官、余额、最近一条决策），
 * 写进环形文件 state/blackbox.jsonl（超过 8MB 只留最近 4000 行）。
 * 当某个关键项从「正常」变「不正常」并持续 60 秒，就开始记事故；恢复正常 60 秒后
 * 落一份事故报告到 archive/incidents/<时间>.md —— 只写文件，不打扰任何人。
 *
 * 用法：node blackbox/blackbox.mjs  |  --status
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { ROOT, STATE, stamp } from '../lib/base.mjs';

const NAME = 'blackbox';
const LOCK = path.join(STATE, `${NAME}.lock`);
const LOG = path.join(STATE, 'blackbox.jsonl');
const CUR = path.join(STATE, 'blackbox-incident.json');
const INC_DIR = path.join(ROOT, 'archive', 'incidents');
const TICK_MS = 20000;
const MAX_BYTES = 8 * 1024 * 1024;
const BAD_CONFIRM_MS = 60000;
const RECOVER_MS = 60000;

const STATUS_ONLY = process.argv.includes('--status');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function readPid(p) { try { return Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch { return 0; } }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function portOpen(port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
function nowIso(now) { return new Date(now).toISOString(); }
function trimLog() {
  try {
    const st = fs.statSync(LOG);
    if (st.size < MAX_BYTES) return;
    const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-4000);
    fs.writeFileSync(LOG, lines.join('\n') + '\n');
  } catch {}
}

async function snapshot() {
  const now = Date.now();
  const stateDir = STATE;
  const brainPid = readPid(path.join(stateDir, 'brain.lock'));
  const bj = readJson(path.join(stateDir, 'brain.json')) || {};
  const brainAge = bj.at ? now - Date.parse(bj.at) : -1;
  const napcat = await portOpen(3000);
  const bridge = await portOpen(3100);
  const lockOf = (n) => { const p = readPid(path.join(stateDir, `${n}.lock`)); return { pid: p, alive: pidAlive(p) }; };
  const org = {};
  for (const n of ['eye', 'medic', 'mouth', 'vitals', 'treasurer', 'hippocampus', 'ears']) org[n] = lockOf(n).alive;
  const workers = Array.isArray(bj.workers) ? bj.workers : [];
  const lastDec = (() => {
    try {
      const lines = fs.readFileSync(path.join(stateDir, 'brain-decisions.jsonl'), 'utf8').trim().split('\n');
      return JSON.parse(lines[lines.length - 1]);
    } catch { return null; }
  })();
  const bw = readJson(path.join(ROOT, 'state', 'balance-watch.json')) || {};
  return {
    ts: now,
    at: nowIso(now),
    napcat,
    bridge,
    brain: { pid: brainPid, alive: pidAlive(brainPid), ageSec: brainAge < 0 ? -1 : Math.round(brainAge / 1000) },
    hemis: {
      left: bj.hemis?.left?.status || null,
      right: bj.hemis?.right?.status || null,
      cerebellum: bj.hemis?.cerebellum?.status || null,
    },
    workers: { running: workers.filter((w) => w.alive).length, total: workers.length, stale: workers.filter((w) => w.alive && (w.lockAgeSec || 0) > 180).map((w) => w.name) },
    organs: org,
    balance: Number(bw.lastBalance) || 0,
    lastDecision: lastDec ? { at: lastDec.at, rule: lastDec.rule, action: lastDec.action } : null,
  };
}

function problems(s) {
  const list = [];
  if (!s.napcat) list.push(':3000 NapCat 不通');
  if (!s.bridge) list.push(':3100 桥接不通');
  if (!s.brain.alive) list.push('主脑不在');
  else if (s.brain.ageSec > 150) list.push(`主脑 ${s.brain.ageSec}s 没心跳`);
  for (const [k, v] of Object.entries(s.hemis)) if (v === 'offline') list.push(`${k} 下线`);
  for (const [k, v] of Object.entries(s.organs)) if (!v) list.push(`器官 ${k} 不在`);
  for (const w of s.workers.stale) list.push(`worker ${w} 锁僵住`);
  return list;
}

function printStatus() {
  const s = readJson(path.join(STATE, 'blackbox.json')) || {};
  const cur = readJson(CUR);
  console.log(`黑匣子：${s.at ? new Date(s.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '还没录过'}`);
  console.log(`  最近快照：NapCat ${s.napcat ? '通' : '断'} / 桥接 ${s.bridge ? '通' : '断'}，worker ${s.workers?.running}/${s.workers?.total}`);
  console.log(cur && cur.status === 'open' ? `  正在记事故：${(cur.problems || []).join('；')}` : '  没有未结事故');
}

async function main() {
  if (STATUS_ONLY) { printStatus(); return; }
  const old = readPid(LOCK);
  if (old && old !== process.pid && pidAlive(old)) { console.log('黑匣子已有实例在跑'); process.exit(3); }
  fs.writeFileSync(LOCK, String(process.pid));
  const beat = setInterval(() => { try { fs.writeFileSync(LOCK, String(process.pid)); } catch {} }, 20000);
  beat.unref?.();
  process.on('exit', () => { try { if (readPid(LOCK) === process.pid) fs.unlinkSync(LOCK); } catch {} });

  let badSince = 0;
  let okSince = 0;

  for (;;) {
    try {
      const s = await snapshot();
      trimLog();
      try { fs.appendFileSync(LOG, JSON.stringify(s) + '\n'); } catch {}
      fs.writeFileSync(path.join(STATE, 'blackbox.json'), JSON.stringify(s, null, 2));

      const probs = problems(s);
      const cur = readJson(CUR) || {};

      if (probs.length) {
        okSince = 0;
        if (!badSince) badSince = s.ts;
        if (!cur.status || cur.status === 'closed') {
          if (s.ts - badSince >= BAD_CONFIRM_MS) {
            const incident = { id: nowIso(s.ts), status: 'open', startedAt: nowIso(badSince), problems: probs, events: [{ at: nowIso(s.ts), text: probs.join('；') }] };
            fs.writeFileSync(CUR, JSON.stringify(incident, null, 2));
            console.log(`[${stamp()}] 开始记事故：${probs.join('；')}`);
          }
        } else if (cur.status === 'open') {
          const last = cur.events[cur.events.length - 1];
          const text = probs.join('；');
          if (!last || last.text !== text) {
            cur.events.push({ at: nowIso(s.ts), text });
            if (cur.events.length > 200) cur.events = cur.events.slice(-200);
            fs.writeFileSync(CUR, JSON.stringify(cur, null, 2));
          }
        }
      } else {
        badSince = 0;
        if (!okSince) okSince = s.ts;
        if (cur.status === 'open' && s.ts - okSince >= RECOVER_MS) {
          cur.status = 'closed';
          cur.endedAt = nowIso(s.ts);
          cur.durationSec = Math.round((s.ts - Date.parse(cur.startedAt)) / 1000);
          cur.events.push({ at: nowIso(s.ts), text: '恢复正常' });
          try { fs.mkdirSync(INC_DIR, { recursive: true }); } catch {}
          const name = `incident-${cur.startedAt.replace(/[:.]/g, '-')}.md`;
          const md = [
            `# 事故 ${cur.startedAt} → ${cur.endedAt}（${Math.round(cur.durationSec / 60)} 分钟）`,
            '',
            '## 起因（进入事故时看到的问题）',
            ...cur.problems.map((p) => '- ' + p),
            '',
            '## 时间线',
            ...cur.events.map((e) => `- ${e.at}  ${e.text}`),
            '',
            '## 当时的最后一条决策',
            s.lastDecision ? `- ${s.lastDecision.at} ${s.lastDecision.rule} → ${s.lastDecision.action}` : '- （没有）',
          ].join('\n');
          fs.writeFileSync(path.join(INC_DIR, name), md);
          fs.writeFileSync(CUR, JSON.stringify(cur, null, 2));
          console.log(`[${stamp()}] 事故结束，报告：archive/incidents/${name}`);
        }
      }
    } catch (e) {
      console.log(`[${stamp()}] 黑匣子出错：${e.message}`);
    }
    await sleep(TICK_MS);
  }
}

main();
