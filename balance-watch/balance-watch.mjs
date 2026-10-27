#!/usr/bin/env node
import { singleInstance } from '../lock/single.mjs';
singleInstance('balance');
/**
 * balance-watch —— DeepSeek 余额守门员
 *
 * 每 N 分钟查一次官方余额接口；低于阈值就用 NapCat 给主人发 QQ 私聊提醒。
 * 不依赖模型、不依赖 DSH，只要 NapCat 在线就能跑。
 *
 * 配置（环境变量或同目录 balance-watch.json）：
 *   DEEPSEEK_KEY_FILE   默认 ~/.dsh/.credentials.yaml
 *   NAPCAT_HTTP         默认 http://127.0.0.1:3000
 *   OWNER_QQ            默认 YOUR_QQ
 *   THRESHOLD_CNY       默认 10
 *   INTERVAL_MIN        默认 30
 *   ALERT_COOLDOWN_H    同一阈值内重复提醒的最小间隔，默认 6 小时
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const STATE_FILE = path.join(HERE, '..', 'state', 'balance-watch.json');

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'balance-watch.json'), 'utf8'));
  } catch {}
  return {
    keyFile: process.env.DEEPSEEK_KEY_FILE || file.keyFile || path.join(os.homedir(), '.dsh', '.credentials.yaml'),
    napcat: process.env.NAPCAT_HTTP || file.napcat || 'http://127.0.0.1:3000',
    ownerQQ: Number(process.env.OWNER_QQ || file.ownerQQ || 0),
    threshold: Number(process.env.THRESHOLD_CNY ?? file.threshold ?? 10),
    intervalMin: Number(process.env.INTERVAL_MIN || file.intervalMin || 30),
    cooldownH: Number(process.env.ALERT_COOLDOWN_H || file.cooldownH || 6),
  };
}

function readKey(file) {
  // 以文件为准。以前先看 process.env，结果用户级环境变量里躺着一个失效的旧 key，
  // 进程继承到它就 401，而手动跑（shell 没这个变量）反而正常 —— 排查了半天。
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/DEEPSEEK_API_KEY:\s*(sk-[A-Za-z0-9_-]+)/);
    if (m) return m[1];
  } catch {}
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  throw new Error(`未在 ${file} 找到 DEEPSEEK_API_KEY`);
}

async function queryBalance(key) {
  const r = await fetch('https://api.deepseek.com/user/balance', {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`余额接口 HTTP ${r.status}`);
  const j = await r.json();
  const cny = (j.balance_infos || []).find((x) => x.currency === 'CNY') || (j.balance_infos || [])[0];
  return {
    available: j.is_available === true,
    currency: cny?.currency || 'CNY',
    total: Number(cny?.total_balance ?? 0),
    granted: Number(cny?.granted_balance ?? 0),
    toppedUp: Number(cny?.topped_up_balance ?? 0),
  };
}

async function sendQQ(cfg, text) {
  const r = await fetch(`${cfg.napcat.replace(/\/+$/, '')}/send_private_msg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: cfg.ownerQQ, message: text }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.status === 'failed' || (typeof j.retcode === 'number' && j.retcode !== 0)) {
    throw new Error(`NapCat 发送失败: ${j.message || j.wording || j.retcode}`);
  }
}

function log(...args) {
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const line = `[${ts}] ${args.join(' ')}`;
  try { console.log(line); } catch {}
  // 以前只写 console，一旦 API 偶发超时导致跳过一轮，外面完全看不到，
  // 只能从 state 的时间戳猜。落一份文件才查得动。
  try {
    const dir = path.dirname(STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'balance-watch.log'), line + '\n');
  } catch {}
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

async function tick(cfg) {
  const state = readState();
  let bal;
  try {
    bal = await queryBalance(readKey(cfg.keyFile));
  } catch (error) {
    log('查余额失败:', error.message);
    return;
  }
  state.lastCheckAt = Date.now();
  state.lastBalance = bal.total;
  log(`余额 ${bal.total.toFixed(2)} ${bal.currency}（阈值 ${cfg.threshold}）`);

  const low = !bal.available || bal.total < cfg.threshold;
  const lastAlert = Number(state.lastAlertAt || 0);
  const cooldownMs = cfg.cooldownH * 3600 * 1000;

  if (low && Date.now() - lastAlert > cooldownMs) {
    const text =
      bal.available === false
        ? `你的 DeepSeek 余额好像用完了（当前 ${bal.total.toFixed(2)} 元），充点吧，不然我要断气了。`
        : `你的 DeepSeek 余额只剩 ${bal.total.toFixed(2)} 元了，记得充一下。`;
    try {
      const critical = bal.total < Number(process.env.CRITICAL_CNY || 1);
      if (process.env.ALERT_QQ === '1' || critical) await sendQQ(cfg, text);
      else log('[静默] 只写本地提醒，不发 QQ');
      state.lastAlertAt = Date.now();
      state.lastAlertText = text;
      try { fs.writeFileSync(path.join(STATE, 'ALERT-balance.txt'), `${new Date().toISOString()} ${text}\n`); } catch {}
      log('已提醒主人:', text);
    } catch (error) {
      log('提醒发送失败:', error.message);
    }
  }
  writeState(state);
}

const cfg = loadConfig();
log(`启动：阈值 ${cfg.threshold} 元 / 每 ${cfg.intervalMin} 分钟查一次 / 主人 ${cfg.ownerQQ}`);
await tick(cfg);
setInterval(() => void tick(cfg), Math.max(5, cfg.intervalMin) * 60 * 1000);
