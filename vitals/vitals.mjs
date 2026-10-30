#!/usr/bin/env node
/**
 * vitals —— 体温计：不是「端口通不通」，是「她到底能不能回话」。
 *
 * 2026-10-30 最坑的一次是：3000/3100 都通、进程全在，他就是等不到回话。
 * 端口探针看不出这种「假在线」，所以这里直接问桥接：
 *   · 有没有未读（unreadCount）
 *   · 她最后一次回话是什么时候（lastAiReplyAt）
 *   · 现在是不是正在处理（busy）
 * 三个凑一起就能判断「有人说话但她没回」。
 *
 * 判定：在线 && 有未读 && 不 busy && 最后回话超过 180 秒 → 卡住；
 *       卡住持续 10 分钟 → 写 state/vitals-alert.json 给主脑（它决定重启桥接还是叫人）。
 *
 * 用法：node vitals/vitals.mjs  |  --status
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE, stamp } from '../lib/base.mjs';

const NAME = 'vitals';
const LOCK = path.join(STATE, `${NAME}.lock`);
const LOG = path.join(STATE, 'vitals.jsonl');
const OUT = path.join(STATE, 'vitals.json');
const ALERT = path.join(STATE, 'vitals-alert.json');
const TICK_MS = 120000;
const STUCK_SEC = 180;
const ALERT_AFTER_MS = 10 * 60 * 1000;

const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');
const STATUS_ONLY = process.argv.includes('--status');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function readPid(p) { try { return Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch { return 0; } }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function token() { try { return fs.readFileSync(path.join(BRIDGE, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; } }
function ownerQQ() {
  try { return String(JSON.parse(fs.readFileSync(path.join(BRIDGE, 'config.json'), 'utf8')).ownerQQ || ''); } catch { return ''; }
}

async function oneBotOnline() {
  try {
    const r = await fetch('http://127.0.0.1:3000/get_login_info', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    return !!(j && j.data && j.data.user_id);
  } catch { return false; }
}

async function bridgeState() {
  const t = token();
  const qq = ownerQQ();
  if (!t || !qq) return null;
  try {
    const r = await fetch(`http://127.0.0.1:3100/api/socialV2/state?key=private:${qq}`, {
      headers: { 'x-console-token': t }, signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function printStatus() {
  const v = readJson(OUT) || {};
  const a = readJson(ALERT) || {};
  console.log(`体温计：${v.at ? new Date(v.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '还没量过'}`);
  console.log(`  QQ ${v.online ? '在线' : '不在线'}，未读 ${v.unread ?? '?'}，busy=${v.busy ?? '?'}，最后回话 ${v.replyAgeSec == null ? '?' : v.replyAgeSec + 's 前'}`);
  console.log(v.stuck ? `  ⚠ 卡住：${v.stuck ? '有人说话但她没回' : ''}` : '  正常');
  if (a.stuck) console.log(`  已上报主脑：从 ${new Date(a.since).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 起卡住`);
}

async function main() {
  if (STATUS_ONLY) { printStatus(); return; }
  const old = readPid(LOCK);
  if (old && old !== process.pid && pidAlive(old)) { console.log('体温计已有实例在跑'); process.exit(3); }
  fs.writeFileSync(LOCK, String(process.pid));
  const beat = setInterval(() => { try { fs.writeFileSync(LOCK, String(process.pid)); } catch {} }, 20000);
  beat.unref?.();
  process.on('exit', () => { try { if (readPid(LOCK) === process.pid) fs.unlinkSync(LOCK); } catch {} });

  let stuckSince = 0;

  for (;;) {
    try {
      const now = Date.now();
      const online = await oneBotOnline();
      const st = await bridgeState();
      const unread = Number(st?.unreadCount) || 0;
      const busy = !!st?.busy;
      const lastReplyAt = st?.lastAiReplyAt ? Number(st.lastAiReplyAt) : 0;
      const replyAgeSec = lastReplyAt ? Math.round((now - lastReplyAt) / 1000) : null;
      const stuck = !!(online && unread > 0 && !busy && (replyAgeSec == null || replyAgeSec > STUCK_SEC));

      if (stuck) { if (!stuckSince) stuckSince = now; } else stuckSince = 0;

      const rec = { at: new Date(now).toISOString(), online, unread, busy, lastWakeReason: st?.lastWakeReason || '', lastReplyAt, replyAgeSec, stuck, stuckSec: stuckSince ? Math.round((now - stuckSince) / 1000) : 0 };
      fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
      try {
        const sz = fs.statSync(LOG).size;
        if (sz > 4 * 1024 * 1024) fs.writeFileSync(LOG, fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-3000).join('\n') + '\n');
      } catch {}
      fs.writeFileSync(OUT, JSON.stringify(rec, null, 2));

      if (stuck && stuckSince && now - stuckSince >= ALERT_AFTER_MS) {
        const a = readJson(ALERT) || {};
        if (!a.stuck) {
          fs.writeFileSync(ALERT, JSON.stringify({ stuck: true, since: new Date(stuckSince).toISOString(), at: rec.at, why: `有人说话但她 ${(replyAgeSec ?? 0)}s 没回`, unread }, null, 2));
          console.log(`[${stamp()}] 体温计：卡住了（未读 ${unread}，${replyAgeSec}s 没回），已上报主脑`);
        }
      } else if (!stuck && fs.existsSync(ALERT)) {
        fs.unlinkSync(ALERT);
        console.log(`[${stamp()}] 体温计：恢复正常`);
      }
    } catch (e) {
      console.log(`[${stamp()}] 体温计出错：${e.message}`);
    }
    await sleep(TICK_MS);
  }
}

main();
