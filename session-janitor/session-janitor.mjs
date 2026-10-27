#!/usr/bin/env node
import { singleInstance } from '../lock/single.mjs';
singleInstance('janitor');
/**
 * session-janitor —— 清理"没用了/不聊了"的会话，避免上下文越拖越长。
 *
 * 规则（可用环境变量覆盖）：
 *   IDLE_HOURS_GROUP    群聊多久没消息就重置，默认 48 小时
 *   IDLE_HOURS_PRIVATE  私聊多久没消息就重置，默认 168 小时（7 天）
 *   CHECK_MIN           多久检查一次，默认 60 分钟
 *   DRY_RUN=1           只打印不执行
 *
 * 重置 = 调桥接的 /api/session/reset，把 QQ 会话和 DSH 会话的映射拆掉；
 * 下次来消息会开一个干净的新会话（她存在 qq_memory 里的事实不会丢）。
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BRIDGE = path.join(HERE, '..', 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');
const STATE = path.join(BRIDGE, 'state');

const IDLE_GROUP_H = Number(process.env.IDLE_HOURS_GROUP || 48);
const IDLE_PRIVATE_H = Number(process.env.IDLE_HOURS_PRIVATE ?? 0); // 0 = 私聊永不重置（保记忆）
const CHECK_MIN = Math.max(5, Number(process.env.CHECK_MIN || 60));
const DRY = process.env.DRY_RUN === '1';

function log(...args) {
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const line = `[${ts}] ${args.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(STATE, 'janitor.log'), line + '\n');
  } catch {}
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function token() {
  return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
}

async function api(pathname, options = {}) {
  const r = await fetch(`http://127.0.0.1:3100${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-console-token': token(), ...(options.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}

async function tick() {
  const sessions = await api('/api/sessions').catch((e) => ({ body: { error: e.message } }));
  const list = Array.isArray(sessions.body) ? sessions.body : (sessions.body?.sessions || []);
  if (!list.length) {
    log('没有会话映射，跳过');
    return;
  }
  const social = readJson(path.join(STATE, 'social-v2.json'), {});
  const conv = social.conversations || {};
  const now = Date.now();
  let reset = 0;

  for (const item of list) {
    const key = String(item.key || '');
    if (!key) continue;
    const st = conv[key] || {};
    const last = Number(st.lastIncomingAt || st.lastActionAt || st.lastAiReplyAt || 0);
    if (!last) {
      log(`跳过 ${key}：没有活动时间记录`);
      continue;
    }
    const idleH = (now - last) / 3600000;
    const limit = key.startsWith('group:') ? IDLE_GROUP_H : IDLE_PRIVATE_H;
    if (limit <= 0) continue; // 该类型不做清理
    if (idleH < limit) continue;

    const hours = idleH.toFixed(1);
    if (DRY) {
      log(`[dry-run] ${key} 已闲置 ${hours}h（阈值 ${limit}h），本应重置`);
      continue;
    }
    const res = await api('/api/session/reset', { method: 'POST', body: JSON.stringify({ key }) });
    if (res.body && res.body.ok) {
      reset += 1;
      log(`已重置 ${key}（闲置 ${hours}h，阈值 ${limit}h）`);
    } else {
      log(`重置失败 ${key}: ${JSON.stringify(res.body).slice(0, 200)}`);
    }
  }

  log(`本轮结束：会话 ${list.length} 个，重置 ${reset} 个（群 ${IDLE_GROUP_H}h / 私聊 ${IDLE_PRIVATE_H}h）`);
}

log(`session-janitor 启动：群 ${IDLE_GROUP_H}h / 私聊 ${IDLE_PRIVATE_H}h / 每 ${CHECK_MIN} 分钟${DRY ? ' [DRY-RUN]' : ''}`);
await tick();
setInterval(() => void tick().catch((e) => log('出错:', e.message)), CHECK_MIN * 60000);
