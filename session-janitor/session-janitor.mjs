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
import os from 'node:os';
import path from 'node:path';
import { STATE, stamp, consoleApi as api } from '../lib/base.mjs';

const IDLE_GROUP_H = Number(process.env.IDLE_HOURS_GROUP || 48);
const IDLE_PRIVATE_H = Number(process.env.IDLE_HOURS_PRIVATE ?? 0); // 0 = 私聊永不重置（保记忆）
const CHECK_MIN = Math.max(5, Number(process.env.CHECK_MIN || 60));
const DRY = process.env.DRY_RUN === '1';
/** DSH 会话文件保留多少天（她跟哥的每轮对话都有一份 JSONL，一天约 3 MB） */
const SESSION_KEEP_DAYS = Number(process.env.SESSION_KEEP_DAYS ?? 60);
/** 附件（聊天里的图片、文件）保留多少天 */
const ATTACH_KEEP_DAYS = Number(process.env.ATTACH_KEEP_DAYS ?? 90);
const DSH_DIR = path.join(os.homedir(), '.dsh');

function log(...args) {
  const ts = stamp();
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

async function tick() {
  // 先清空间（跟「重置会话」无关，没映射也要照清）
  pruneOld(path.join(DSH_DIR, 'sessions'), SESSION_KEEP_DAYS, '老会话文件');
  pruneOld(path.join(DSH_DIR, 'attachments'), ATTACH_KEEP_DAYS, '老附件');

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

/**
 * 清掉太老的会话文件 / 附件。
 *
 * 为什么管这个：她跟哥的每一轮对话都会在 ~/.dsh/sessions 里留一份 JSONL，
 * 实测一天约 3 MB —— 一年 1 GB 出头，比记忆本体（几十 KB）大四个数量级。
 * 记忆本体（facts/话题/印象）和聊天档案（archive/）**永远不碰**，
 * 这里清的只是「DSH 的会话记录」和「聊天里的图片缓存」，都是可以再生的。
 * 保留天数用 SESSION_KEEP_DAYS / ATTACH_KEEP_DAYS 调，设 0 关掉。
 */
function pruneOld(dir, keepDays, label) {
  if (!keepDays || keepDays <= 0 || !fs.existsSync(dir)) return;
  const cutoff = Date.now() - keepDays * 86400000;
  let n = 0;
  let bytes = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs >= cutoff) continue;
      if (DRY) { log(`[dry-run] 会删 ${label}: ${path.basename(p)}（${(st.size / 1048576).toFixed(1)} MB）`); continue; }
      try { fs.unlinkSync(p); n += 1; bytes += st.size; } catch {}
    }
  };
  walk(dir);
  if (!DRY && n) log(`清掉 ${label} ${n} 个，释放 ${(bytes / 1048576).toFixed(1)} MB（保留 ${keepDays} 天）`);
}

log(`session-janitor 启动：群 ${IDLE_GROUP_H}h / 私聊 ${IDLE_PRIVATE_H}h / 每 ${CHECK_MIN} 分钟${DRY ? ' [DRY-RUN]' : ''}`);
await tick();
setInterval(() => void tick().catch((e) => log('出错:', e.message)), CHECK_MIN * 60000);
