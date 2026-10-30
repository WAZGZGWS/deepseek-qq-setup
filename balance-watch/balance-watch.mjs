#!/usr/bin/env node
import { singleInstance } from '../lock/single.mjs';
// --selftest 只是打印几条候选文案，不该被「已有实例在跑」挡掉
if (!process.argv.includes('--selftest')) singleInstance('balance');
/**
 * balance-watch —— DeepSeek 余额守门员
 *
 * 每 N 分钟查一次官方余额接口，余额越低提醒越勤，提醒里带充值链接。
 * 不依赖模型、不依赖 DSH，只要 NapCat 在线就能直接把消息推到你手机上。
 *
 * 四档提醒（越低越急）：
 *   < 1 元   每小时      基本快断气
 *   < 2 元   每 3 小时
 *   < 5 元   每 6 小时
 *   < 10 元  每 12 小时
 * 每档各自计时，不会因为刚提醒过 10 元档就把 1 元档的提醒也吃掉。
 *
 * 配置（环境变量或同目录 balance-watch.json）：
 *   DEEPSEEK_KEY_FILE   默认 ~/.dsh/.credentials.yaml
 *   NAPCAT_HTTP         默认 http://127.0.0.1:3000
 *   OWNER_QQ            默认取桥接 config.json 的 ownerQQ
 *   INTERVAL_MIN        默认 30
 *   THRESHOLD_CNY       覆盖最高档阈值（默认 10）
 *   TOPUP_URL           充值页地址
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stamp, dirOf } from '../lib/base.mjs';

const HERE = dirOf(import.meta.url);

const STATE_DIR = path.join(HERE, '..', 'state');
const STATE_FILE = path.join(STATE_DIR, 'balance-watch.json');
const LOG_FILE = path.join(STATE_DIR, 'balance-watch.log');
const TOPUP_URL = process.env.TOPUP_URL || 'https://platform.deepseek.com/top_up';

// 充上钱道谢的话：每次都不一样，但不至于乱 —— 从池子里挑，最近 6 次用过的别再出现
// （state.recentThanks 记着）。为什么不用模型现写：这一步本来零 token，
// 为了道个谢去唤醒一次模型不划算。
const THANKS_BASE = [
  '哥你充上啦，我又能说话了',
  '钱到账了，我的嗓子也回来了',
  '哟，舍得给我充了',
  '到账了哥，我先把嘴张开',
  '充上了，那我就不客气地接着说',
  '嗯，钱到了，我不装死了',
  '哥你这一充，我从静音模式切回来了',
  '收到，说话额度回来了',
  '充上了，接下来我尽量挑重要的说',
  '钱到账，我心里有数，会省着说的',
  '哟，这回充得挺快',
  '到账了，我继续念叨你',
  '活过来了，谢谢哥',
  '充上了哥，我少说废话',
  '到账。放心，我不乱花你的钱',
  '钱到账了，我刚才没说完的那句话还在',
];
const THANKS_SUFFIX = ['', '，省着点用', '，别嫌我话多', '，这次我盯紧余额'];

/** 挑一句「充上了」的道谢；最近用过的排除在外 */
function pickThanks(state) {
  const recent = Array.isArray(state.recentThanks) ? state.recentThanks : [];
  const pool = [];
  for (const b of THANKS_BASE) for (const s of THANKS_SUFFIX) pool.push(b + s);
  const fresh = pool.filter((x) => !recent.includes(x));
  const from = fresh.length ? fresh : pool;
  const pick = from[Math.floor(Math.random() * from.length)];
  state.recentThanks = [...recent, pick].slice(-6);
  return pick;
}

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'balance-watch.json'), 'utf8'));
  } catch {}

  // 主人 QQ：优先 env，其次文件，最后从桥接配置里读（避免两边写死不一致）
  let ownerQQ = Number(process.env.OWNER_QQ || file.ownerQQ || 0);
  if (!ownerQQ) {
    try {
      const c = JSON.parse(
        fs.readFileSync(path.join(HERE, '..', 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'config.json'), 'utf8'),
      );
      ownerQQ = Number(c.ownerQQ) || 0;
    } catch {}
  }

  const top = Number(process.env.THRESHOLD_CNY ?? file.threshold ?? 10);

  return {
    keyFile: process.env.DEEPSEEK_KEY_FILE || file.keyFile || path.join(os.homedir(), '.dsh', '.credentials.yaml'),
    napcat: process.env.NAPCAT_HTTP || file.napcat || 'http://127.0.0.1:3000',
    ownerQQ,
    intervalMin: Number(process.env.INTERVAL_MIN || file.intervalMin || 30),
    tiers: [
      { at: 1, cooldownH: 1 },
      { at: 2, cooldownH: 3 },
      { at: 5, cooldownH: 6 },
      { at: Math.max(6, top), cooldownH: 12 },
    ],
  };
}

/** 今天的日期（北京时间，YYYY-MM-DD） */
function todayMd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

/** 今天（北京时间）是不是「放宽日」：读 balance-watch.json 的 lenientDates，格式 MM-DD */
function isLenientDay() {
  try {
    const file = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'balance-watch.json'), 'utf8'));
    const list = Array.isArray(file.lenientDates) ? file.lenientDates.map((x) => String(x).trim()) : [];
    if (!list.length) return false;
    const md = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(5); // MM-DD
    return list.includes(md);
  } catch {
    return false;
  }
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
  };
}

// ── 余额驱动的「说话频率」开关 ────────────────────────────────────────────────
// ── 静默时段不发消息 ────────────────────────────────────────────────────────
// 余额提醒是绕过 AI 直接调 NapCat 发的，所以桥接的静默时段拦不住它。
// 不加这道闸，半夜 3 点钱快没了就会真的把你吵醒。宁可等到早上再说。
const SILENCE_FILE = path.join(HERE, '..', 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'state', 'silence-schedule.json');

function cnHHMM() {
  return new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 5);
}

function inQuietHours() {
  try {
    const j = JSON.parse(fs.readFileSync(SILENCE_FILE, 'utf8'));
    const cfg = j.config || {};
    if (cfg.enabled === false) return false;
    const now = cnHHMM();
    for (const r of cfg.ranges || []) {
      if (r.enabled === false) continue;
      const s = String(r.start);
      const e = String(r.end);
      // 跨零点的区间（如 23:00-07:00）
      const hit = s <= e ? now >= s && now < e : now >= s || now < e;
      if (hit) return true;
    }
  } catch {}
  return false;
}

// 钱多的时候允许她偶尔主动开口（20~25% 机会 / 安静半小时以上才判定）；
// 钱快没了就自动收敛：先降概率、再关掉主动、最后连回复也缩短。
// 走桥接控制台 POST /api/socialV2/config，改完立刻生效并落盘到 config.json。
const MODES = [
  {
    id: 'critical',
    below: 1,
    patch: { proactive: { enabled: false }, send: { burstMaxMessages: 2, maxMessageChars: 160 } },
  },
  {
    id: 'tight',
    below: 2,
    patch: { proactive: { enabled: false } },
  },
  {
    id: 'low',
    below: 5,
    patch: {
      proactive: {
        enabled: true,
        probability: 0.1,
        checkIntervalMinMs: 5400000,
        checkIntervalMaxMs: 9000000,
        idleThresholdMs: 3600000,
      },
    },
  },
  {
    id: 'normal',
    below: Infinity,
    patch: {
      proactive: {
        enabled: true,
        probability: 0.25,
        checkIntervalMinMs: 2700000,
        checkIntervalMaxMs: 5400000,
        idleThresholdMs: 1800000,
      },
      send: { burstMaxMessages: 8, maxMessageChars: 500 },
    },
  },
];

function pickMode(total) {
  // 升序，第一个命中就是最紧的一档
  return MODES.find((m) => total < m.below) || MODES[MODES.length - 1];
}

function consoleToken() {
  try {
    return fs
      .readFileSync(path.join(HERE, '..', 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'state', 'console-token'), 'utf8')
      .trim();
  } catch {
    return '';
  }
}

async function applyMode(cfg, mode) {
  const token = consoleToken();
  if (!token) {
    log('拿不到桥接 console-token，跳过模式切换');
    return false;
  }
  const base = (cfg.napcat || 'http://127.0.0.1:3000').replace(/\/+$/, '').replace(/:3000$/, ':3100');
  try {
    const r = await fetch(`${base}/api/socialV2/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify(mode.patch),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(`HTTP ${r.status}`);
    log(`说话频率切到「${mode.id}」档：${JSON.stringify(mode.patch)}`);
    return true;
  } catch (e) {
    log(`切换模式失败（桥接可能没起来）: ${e.message}`);
    return false;
  }
}

async function sendQQ(cfg, text) {  if (!cfg.ownerQQ) throw new Error('没有 ownerQQ，不知道发给谁');
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
  const ts = stamp();
  const line = `[${ts}] ${args.join(' ')}`;
  try { console.log(line); } catch {}
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > 512 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch {}
    fs.appendFileSync(LOG_FILE, line + '\n');
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
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

function tierText(total, tierAt, available) {
  // 写成人话，不要出现"余额""接口""系统""自动恢复"这类运维词——
  // 聊天窗口里冒出技术说词会让她当场破功。
  const money = total.toFixed(1);
  if (!available) {
    return `哥，我这边钱用光了，一句话都说不出来了。帮我充一点点好不好\n${TOPUP_URL}`;
  }
  if (tierAt <= 1) return `哥，只剩 ${money} 块了，再说几句我就哑了。\n${TOPUP_URL}`;
  if (tierAt <= 2) return `哥，就剩 ${money} 块了，撑不了多久啦。\n${TOPUP_URL}`;
  if (tierAt <= 5) return `哥，我这边剩 ${money} 块了，记得给我充一点。\n${TOPUP_URL}`;
  return `哥，我这边还剩 ${money} 块，一天大概要花两块多，你先留意着点。\n${TOPUP_URL}`;
}

async function tick(cfg) {
  const state = readState();

  // 上轮没发出去的（比如当时 QQ 掉线），这轮先补。静默时段不补，等到早上。
  if (state.pending && inQuietHours()) {
    log('[静默] 有排队提醒，但现在是她不该说话的时段，等静默结束再发');
  } else if (state.pending) {
    try {
      await sendQQ(cfg, state.pending);
      log('补发了上轮没发出去的提醒');
      delete state.pending;
    } catch (e) {
      log('补发仍失败:', e.message);
    }
  }

  let bal;
  try {
    bal = await queryBalance(readKey(cfg.keyFile));
  } catch (error) {
    log('查余额失败:', error.message);
    writeState(state);
    return;
  }

  state.lastCheckAt = Date.now();
  state.lastBalance = bal.total;
  log(`余额 ${bal.total.toFixed(2)} ${bal.currency}`);

  // 生日放宽：她那边的日子（和她自己定的、主人 11-20）不催余额。
  // 每天只记一次日志，免得每个 tick 都刷；账照记（lastBalance 已写），只是不提醒。
  if (isLenientDay()) {
    if (state.lenientDay !== todayMd()) {
      state.lenientDay = todayMd();
      log('今天是她/他的生日 —— 余额提醒放宽：只记账，不催');
      writeState(state);
    }
    return;
  }

  // 按余额切换「说话频率」（只在档位变化时才调接口，避免每 30 分钟写一次配置）
  const mode = pickMode(bal.available ? bal.total : 0);
  if (state.mode !== mode.id) {
    if (await applyMode(cfg, mode)) state.mode = mode.id;
  }

  // ---- 已充值：道个谢，把所有档位复位 ----
  const topTier = cfg.tiers[cfg.tiers.length - 1].at;
  if (bal.total >= topTier && state.wasLow) {
    state.wasLow = false;
    state.alerts = {};
    const text = pickThanks(state);
    try {
      if (inQuietHours()) {
        log('[静默] 想道谢，但现在不该说话，排到静默结束');
        state.pending = text;
      } else {
        await sendQQ(cfg, text);
        log('已道谢:', text);
      }
    } catch (e) {
      log('道谢没发出去:', e.message);
      state.pending = text;
    }
    writeState(state);
    return;
  }

  // ---- 挑最紧急的命中档位（升序，第一个命中就是最紧急的）----
  const hit = cfg.tiers.find((t) => (!bal.available || bal.total < t.at));
  if (!hit) {
    // 余额回到所有档位之上：把当初写的告警文件撤掉。
    // 否则 state/ALERT-balance.txt 会一直躺着，事后分不清是旧账还是新告警
    // （stack-doctor 的 ALERT-stack.txt 就是这个规矩，这里之前漏了）。
    try {
      const af = path.join(STATE_DIR, 'ALERT-balance.txt');
      if (fs.existsSync(af)) {
        fs.unlinkSync(af);
        log(`余额回到 ${bal.total.toFixed(2)} 元，撤掉告警文件`);
      }
    } catch {}
    writeState(state);
    return;
  }
  state.wasLow = true;

  const alerts = state.alerts || (state.alerts = {});
  const last = Number(alerts[hit.at] || 0);
  if (Date.now() - last < hit.cooldownH * 3600 * 1000) {
    writeState(state);
    return;
  }

  const text = tierText(bal.total, hit.at, bal.available);
  try {
    if (inQuietHours()) {
      log(`[静默] 想提醒 <${hit.at} 元档，但现在不该说话，等静默结束`);
      state.pending = text;
    } else {
      await sendQQ(cfg, text);
      alerts[hit.at] = Date.now();
      state.lastAlertText = text;
      log(`已提醒 <${hit.at} 元档: ${text.split('\n')[0]}`);
    }
  } catch (e) {
    log('提醒发送失败（下轮补发）:', e.message);
    state.pending = text;
  }

  // 无论如何也写一份本地告警，方便事后查
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'ALERT-balance.txt'), `${new Date().toISOString()}\n${text}\n`);
  } catch {}

  writeState(state);
}

const cfg = loadConfig();
log(
  `启动：档位 ${cfg.tiers.map((t) => '<' + t.at).join(' / ')} 元，每 ${cfg.intervalMin} 分钟查一次，` +
    `主人 ${cfg.ownerQQ || '(未配置)'}，充值页 ${TOPUP_URL}`,
);
await tick(cfg);
if (process.argv.includes('--selftest')) {
  const st = {};
  console.log('充上钱时可能说的 8 句（同一进程里连抽，最近 6 次不重复）：');
  for (let i = 0; i < 8; i += 1) console.log('  ' + pickThanks(st));
  process.exit(0);
}

setInterval(() => void tick(cfg), Math.max(5, cfg.intervalMin) * 60 * 1000);
