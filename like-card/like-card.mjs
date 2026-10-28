#!/usr/bin/env node
/**
 * like-card —— 每天给哥的名片点个赞（不花一分 token）
 *
 * 为什么单独拎出来：
 *   让"她"去点赞要先唤醒她，一次唤醒 = 一整份上下文 ≈ 1 分钱，就为了点个赞。
 *   点赞是个不需要语言的动作，交给脚本就行，0 元。
 *   省下来的那次唤醒，可以拿来说句话。
 *
 * 一天最多点一次；重复跑不会重点。NapCat 没起来就跳过，等下一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, stamp } from '../lib/base.mjs';

const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'like-card.json');
const LOG_FILE = path.join(STATE_DIR, 'like-card.log');
const BRIDGE_CFG = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'config.json');
const API = process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000';

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch {}
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
  try { console.log(line); } catch {}
}

function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function ownerQQ() {
  try {
    const c = JSON.parse(fs.readFileSync(BRIDGE_CFG, 'utf8'));
    return Number(c.ownerQQ) || 0;
  } catch {
    return 0;
  }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function writeState(s) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

async function main() {
  const uid = ownerQQ();
  if (!uid) {
    log('读不到 ownerQQ，跳过');
    return;
  }

  const st = readState();
  if (st.lastDay === today()) {
    // 今天已经点过了，悄悄退出（不写日志，免得每天刷一行）
    return;
  }

  try {
    const r = await fetch(`${API}/send_like`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: uid, times: 1 }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (typeof j.retcode === 'number' && j.retcode !== 0)) {
      log(`点赞失败：HTTP ${r.status} ${j.message || j.wording || ''}`.trim());
      return;
    }
    st.lastDay = today();
    st.lastAt = Date.now();
    st.count = Number(st.count || 0) + 1;
    writeState(st);
    log(`已给 ${uid} 点赞（累计 ${st.count} 次）`);
  } catch (e) {
    log(`点赞失败（NapCat 可能没起来）：${e.message}`);
  }
}

await main();
