#!/usr/bin/env node
/**
 * bridge-reload —— 挑一个没人聊天的时候把桥接换成新代码，然后一直守着它。
 *
 * 为什么要这么绕：改完 bridge.js 必须重启进程才生效，但 /api/restart 是
 * process.exit —— 如果外面没有守护窗口，桥接就永久停了、QQ 全失联。
 * 这个脚本做三件事：
 *   1. 等"安静"（连续 QUIET_MIN 分钟没有收发消息）再动手，绝不打断聊天
 *   2. 调 /api/restart，让桥接自己优雅退出（它会保存会话映射和记忆）
 *   3. 之后每 5 秒看一次 :3100，起不来自动拉起；已起来就什么都不做
 *      （兼容 2-启动桥接.bat 的 loop：那边 5 秒内会拉起来，这里看到端口通了就不抢）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BRIDGE, STATE, stamp, chatKey, portOpen, consoleToken as token, dirOf } from '../lib/base.mjs';

const HERE = dirOf(import.meta.url);

const KEY = chatKey();
const QUIET_MIN = Number(process.env.QUIET_MIN || 8);
const GUARD_SEC = 5;

function log(...a) {
  const line = `[${stamp()}] ${a.join(' ')}`;
  console.log(line);
  // state 目录 ACL 被桥接收紧，运维身份未必写得进去：优先写本目录
  for (const dir of [HERE, STATE]) {
    try { fs.appendFileSync(path.join(dir, 'bridge-reload.log'), line + '\n'); return; } catch {}
  }
}

// 单例锁（放可写目录，能杀不掉旧实例时至少不会自己撞自己）
const LOCK = path.join(HERE, 'bridge-reload.lock');
try {
  const old = Number(fs.readFileSync(LOCK, 'utf8').trim());
  if (old && old !== process.pid) {
    try { process.kill(old, 0); console.log(`[bridge-reload] 已有实例在跑 pid ${old}，本进程退出`); process.exit(0); } catch {}
  }
} catch {}
try { fs.writeFileSync(LOCK, String(process.pid)); } catch {}

function lastActivityAt() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(STATE, 'social-v2.json'), 'utf8'));
    const c = (s.conversations || {})[KEY] || {};
    const t = [c.lastIncomingAt, c.lastActionAt, c.lastAiReplyAt]
      .map((v) => Number(v) || 0)
      .reduce((a, b) => Math.max(a, b), 0);
    const sents = Array.isArray(c.sendTimes) ? c.sendTimes : [];
    const lastSend = sents.length ? Number(sents[sents.length - 1]) : 0;
    return Math.max(t, lastSend);
  } catch { return 0; }
}

let reloaded = false;

async function quietLongEnough() {
  // 连续观察三轮都安静才算数，避免正好卡在两句话之间
  for (let i = 0; i < 3; i++) {
    const idleMin = (Date.now() - lastActivityAt()) / 60000;
    if (idleMin < QUIET_MIN) return false;
    await new Promise((r) => setTimeout(r, 30000));
  }
  return true;
}

async function doReload() {
  log(`已安静超过 ${QUIET_MIN} 分钟，准备重载桥接（让 replyCheck 改动生效）`);
  try {
    const r = await fetch('http://127.0.0.1:3100/api/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token() },
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    log('重启请求返回:', JSON.stringify(j).slice(0, 160));
  } catch (e) {
    log('重启请求失败（可能已经退出）:', e.message);
  }
  reloaded = true;
}

// ── 阶段一：等安静，然后重载 ───────────────────────────────────────────
async function waitAndReload() {
  log(`启动：等连续 ${QUIET_MIN} 分钟没消息就重载桥接`);
  // 最多等 6 小时，别无限挂着
  const deadline = Date.now() + 6 * 3600 * 1000;
  while (Date.now() < deadline) {
    if (await quietLongEnough()) {
      await doReload();
      return;
    }
    await new Promise((r) => setTimeout(r, 60000));
  }
  log('等了 6 小时都没等到安静，放弃本次重载（下次开机会自然用新代码）');
}

// ── 阶段二：守护 ──────────────────────────────────────────────────────
let lastUp = true;
async function guard() {
  const up = await portOpen(3100);
  if (up) {
    if (!lastUp) log('3100 已恢复监听');
    lastUp = true;
    return;
  }
  // 连续两次都不通才动手，避免正好卡在别人重启的缝里
  const again = await portOpen(3100);
  if (again) { lastUp = true; return; }
  lastUp = false;
  try {
    // 桥接自己的 stdout 也写本目录（state 对我只读）
    const out = fs.openSync(path.join(HERE, 'bridge-spawn.log'), 'a');
    const child = spawn(process.execPath, ['src/bridge.js'], {
      cwd: BRIDGE,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    log(`3100 不通，已拉起桥接 pid ${child.pid}`);
    child.on('exit', (code) => log(`拉起的桥接退出 code=${code}`));
  } catch (e) {
    log('拉起桥接失败:', e.message);
  }
}

await waitAndReload();
log('进入守护模式：每 5 秒检查 :3100');
await guard();
setInterval(() => void guard().catch((e) => log('守护出错:', e.message)), GUARD_SEC * 1000);
