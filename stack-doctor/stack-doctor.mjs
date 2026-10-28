#!/usr/bin/env node
/**
 * stack-doctor — 全栈健康检查，专门为「人不在家」设计
 *
 * 背景（2026-10-27 实测）：
 *   · 13:33 QQ 被服务端踢下线（KickedOffLine：登录已失效），到 20:50 无人处理
 *   · 09:00 常驻看门狗自己死了，死了没人知道
 *   · 启动文件夹里只有 restore / bridge / supervisor，**DSH 本体没有自启**
 *
 * 设计原则：不常驻。计划任务每 2 分钟拉起一次，跑完就退。
 * 常驻进程有"活着"这个状态，所以会死；一次性脚本没有这个状态。
 *
 * 检查项：
 *   napcat(:3000)  掉了 → launcher.bat -q 快速登录
 *   bridge(:3100)  掉了 → 2-启动桥接.bat
 *   dsh(进程)      掉了 → 直接拉起 DeepSeek Harness.exe
 *   状态变化时用 OneBot 直接发 QQ 私聊（不经过 AI，AI 挂了也能发）
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WORKER_NAMES } from '../supervisor/workers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'stack-doctor.json');
const LOG_FILE = path.join(STATE_DIR, 'stack-doctor.log');
const ALERT_FILE = path.join(STATE_DIR, 'ALERT-stack.txt');
const ALERT_PS1 = path.join(ROOT, 'napcat-watchdog', 'desktop-alert.ps1');

const NAPCAT_DIR = process.env.NAPCAT_DIR || path.join(ROOT, 'napcat', 'napcat');
// 这几个启动脚本的名字每个部署都不一样，用环境变量可以覆盖，方便别人拿去用
const BOOT_BAT = process.env.NAPCAT_BOOT_BAT || path.join(ROOT, 'napcat-boot.bat');
const BRIDGE_BAT = process.env.BRIDGE_BAT || path.join(ROOT, '2-启动桥接.bat');
const SUPERVISOR_BAT = process.env.SUPERVISOR_BAT || path.join(ROOT, '20-supervisor.bat');
const WORKER_STATE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'state');
// 工人名单来自 supervisor/workers.mjs —— 那边加人，这边自动就数到，不用改第二处
const DSH_EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
const BRIDGE_CFG = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'config.json');

const API = process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000';
const FAIL_LIMIT = Number(process.env.FAIL_LIMIT || 2);
const MAX_PER_HOUR = Number(process.env.MAX_PER_HOUR || 4);
const COOLDOWN_MS = Number(process.env.COOLDOWN_SEC || 150) * 1000;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const HOUR = 3600 * 1000;
// 重试窗口：原来是「每小时最多 4 次」，等于整夜每小时内都会新开 4 个二维码窗口。
// 改成 6 小时内最多 4 次：夜里票据失效时只会弹 4 次，不会刷屏。
const RETRY_WINDOW_H = Number(process.env.RETRY_WINDOW_H || 6);
const RETRY_WINDOW = RETRY_WINDOW_H * HOUR;

/** NapCat WebUI 端口（密码登录走它；从 napcat/config/webui.json 读，读不到按 6099） */
const WEBUI_PORT = (() => {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(NAPCAT_DIR, 'config', 'webui.json'), 'utf8'));
    return Number(c.port) || 6099;
  } catch {
    return Number(process.env.NAPCAT_WEBUI_PORT || 6099);
  }
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > 512 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch {}
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
  try { console.log(line); } catch {} // 计划任务里没有控制台，console 会抛错
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function saveState(s) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    log('写状态失败: ' + e.message);
  }
}

function slot(state, name) {
  if (!state[name]) state[name] = { fails: 0, starts: [], lastStart: 0, downSince: 0, alertedAt: 0 };
  return state[name];
}

function ownerQQ() {
  try {
    const c = JSON.parse(fs.readFileSync(BRIDGE_CFG, 'utf8'));
    return Number(c.ownerQQ) || 0;
  } catch {
    return 0;
  }
}

// 明确不做的事：往聊天里发"系统通知"。
//
// 2026-10-27 的教训：之前恢复时会发「刚才 QQ 掉线了 37 分钟，现在已经自己恢复了」，
// 这种话一出现，她的人设当场破功——聊天窗口里突然冒出个运维机器人。
// 所以这里只写日志 + 弹窗，绝不碰 QQ 通道。要让她说话，只能由她自己说。
function qqSay() {
  return false;
}

async function probeNapcat() {
  try {
    const r = await fetch(`${API}/get_login_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
    const j = await r.json();
    const uin = j?.data?.user_id;
    return uin ? { ok: true, uin } : { ok: false, why: '未登录' };
  } catch (e) {
    return { ok: false, why: e.code || e.message };
  }
}

function probePort(port, host = '127.0.0.1', timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

/**
 * 后台脚本活着几个：数 state/ 里新鲜的心跳锁。
 *
 * supervisor 自己不写心跳（supervisor.lock 永远是旧的），
 * 但每个 worker 每 20 秒刷新自己的锁，所以数「新鲜的锁」就能判断这一层死没死。
 * 锁在 bridge 的 state 目录里，只读，不需要写权限。
 */
function freshWorkers() {
  let fresh = 0;
  for (const n of WORKER_NAMES) {
    try {
      const st = fs.statSync(path.join(WORKER_STATE, `${n}.lock`));
      if (Date.now() - st.mtimeMs < 5 * 60 * 1000) fresh += 1;
    } catch {}
  }
  return fresh;
}

/**
 * 桥接"假活"检测。
 *
 * 2026-10-27 真实发生过：桥接进程还活着、3100 还监听着、控制台 API 还能调用，
 * 但它对 NapCat 推来的消息毫无反应——你发了消息，她一个字都没回。
 * 端口检查抓不到这种情况，必须比对"NapCat 收到了什么"和"桥接处理了什么"。
 */
function lastNapcatDmMs() {
  try {
    const dir = path.join(NAPCAT_DIR, 'logs');
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!files.length) return 0;
    const { f } = files[0];
    const year = (f.match(/^(\d{4})/) || [])[1] || String(new Date().getFullYear());
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^(\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) .*接收 <- 私聊/);
      if (m) return new Date(`${year}-${m[1]}T${m[2]}+08:00`).getTime();
    }
  } catch {}
  return 0;
}

function bridgeLastIncomingMs() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(WORKER_STATE, 'social-v2.json'), 'utf8'));
    const key = `private:${ownerQQ()}`;
    const c = (s.conversations || {})[key] || {};
    return Number(c.lastIncomingAt || 0);
  } catch {
    return 0;
  }
}

async function bridgeRestartViaApi() {
  try {
    const token = fs.readFileSync(path.join(WORKER_STATE, 'console-token'), 'utf8').trim();
    const r = await fetch('http://127.0.0.1:3100/api/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    return r.ok;
  } catch (e) {
    log('调用桥接重启接口失败: ' + e.message);
    return false;
  }
}

function dshRunning() {  // 不依赖 wmic（Win11 已移除），直接看进程名
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], {
      timeout: 8000,
      windowsHide: true,
      encoding: 'utf8',
    });
    return /DeepSeek Harness\.exe/i.test(out) && !/没有运行的任务|No tasks are running/i.test(out);
  } catch {
    return true; // 查不出来就别乱重启
  }
}

function spawnDetached(exe, args, opts = {}) {
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts });
    child.unref();
    return true;
  } catch (e) {
    log(`启动失败 ${exe}: ${e.message}`);
    return false;
  }
}

/**
 * 用「普通用户权限」启动一个文件。
 *
 * 为什么不用 cmd 直接起：这个任务是 RunLevel=Highest（拉起 NapCat 必须提权），
 * 但桥接的 state 目录带了一个 Low 完整性标签，高权限进程写不进去，桥接会以
 * EPERM 创建 bridge.lock 失败、直接退出，表现为「doctor 说已拉起，但 3100 永远是空的」。
 * explorer.exe 是已登录用户的 shell，由它代开就会退回普通权限，正好能写。
 */
function launchAsUser(target) {
  try {
    const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (e) {
    log(`explorer 启动失败 ${target}: ${e.message}`);
    return false;
  }
}

/**
 * 用普通用户权限启动，并带上参数。
 *
 * explorer.exe 不能传参数，所以先写一个一次性的 .cmd 包一层。
 * 为什么需要 -y：新的启动器会先打印风险提示并等回车（交互时才该出现）。
 * 守护脚本拉起时必须跳过那个提示，否则没人按键，等于没启动。
 */
function launchAsUserVia(target, args = '') {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const safe = path.basename(target).replace(/[^\w.-]/g, '_');
    const wrapper = path.join(STATE_DIR, `_launch-${safe}.cmd`);
    fs.writeFileSync(wrapper, `@echo off\r\ncall "${target}" ${args}\r\nexit /b 0\r\n`, 'ascii');
    return launchAsUser(wrapper);
  } catch (e) {
    log(`包装启动失败 ${target}: ${e.message}`);
    return launchAsUser(target);
  }
}

function desktopAlert(text) {
  try {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const bin = fs.existsSync(ps) ? ps : 'powershell.exe';
    const child = spawn(bin, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ALERT_PS1, '-Text', text], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {}
}

/**
 * 通用处理：某组件掉了就计数，够了就重启，超限就告警
 */
async function handle(state, name, up, restartFn, opts = {}) {
  const s = slot(state, name);
  const label = opts.label || name;

  if (up) {
    if (s.fails > 0 || s.downSince) {
      const downMin = s.downSince ? Math.round((Date.now() - s.downSince) / 60000) : 0;
      log(`${label} 已恢复${downMin ? `（掉线 ${downMin} 分钟）` : ''}`);
      // 恢复不通知聊天：她自己接着聊就行，聊天里不出现任何运维说词。
    }
    // 「需要人工」那个告警文件要撤掉，否则它一直躺在那儿，
    // 下次真出事时你分不清是新告警还是上次没清的旧账（2026-10-28 踩过）。
    // 只清自己写的：别的组件还没恢复时，别把它的告警也抹了。
    if (s.alertedBy === label) {
      try { fs.unlinkSync(ALERT_FILE); } catch {}
      s.alertedBy = '';
      s.alertedAt = 0;
    }
    s.fails = 0;
    s.downSince = 0;
    s.pausedUntil = 0;
    s.starts = s.starts.filter((t) => t > Date.now() - RETRY_WINDOW);
    return;
  }

  s.fails += 1;
  if (!s.downSince) s.downSince = Date.now();
  const downMin = Math.round((Date.now() - s.downSince) / 60000);
  log(`${label} 掉线 ${s.fails}/${FAIL_LIMIT}${opts.why ? `（${opts.why}）` : ''}，已 ${downMin} 分钟`);

  // 等人工验证期间别重试：每两分钟撞一次只会让风控更紧
  if (s.pausedUntil && Date.now() < s.pausedUntil) {
    const leftMin = Math.round((s.pausedUntil - Date.now()) / 60000);
    if (Date.now() - (s.lastPauseLogAt || 0) > 10 * 60 * 1000) {
      log(`${label} 在等人工处理（还有约 ${leftMin} 分钟），这期间不自动重试`);
      s.lastPauseLogAt = Date.now();
    }
    s.fails = 0;
    return;
  }

  if (s.fails < FAIL_LIMIT) return;

  s.starts = s.starts.filter((t) => t > Date.now() - RETRY_WINDOW);
  if (s.starts.length >= MAX_PER_HOUR) {
    log(`${label} 最近 ${RETRY_WINDOW_H} 小时重启 ${s.starts.length} 次仍失败，停止重试（大概率需要人工验证）`);
    if (Date.now() - s.alertedAt > ALERT_COOLDOWN_MS) {
      const text = `${label} 反复掉线，${RETRY_WINDOW_H} 小时内自动重启试了 ${s.starts.length} 次都没成功。\n\n` + (opts.manualHint || '需要人工看一下。');
      try { fs.writeFileSync(ALERT_FILE, `${new Date().toISOString()}\n${text}\n`); } catch {}
      desktopAlert(text);
      s.alertedAt = Date.now();
      s.alertedBy = label;   // 记一笔：这份告警是谁写的，恢复时只撤自己那份
    }
    s.fails = 0;
    return;
  }

  if (Date.now() - s.lastStart < COOLDOWN_MS) {
    log(`${label} 刚重启过，等下一轮`);
    return;
  }

  log(`${label} 尝试重启…`);
  if (await restartFn()) {
    s.lastStart = Date.now();
    s.starts.push(Date.now());
    log(`${label} 已拉起（近 ${RETRY_WINDOW_H} 小时第 ${s.starts.length} 次）`);
  }
  s.fails = 0;
}

async function main() {
  const state = loadState();

  // 1. NapCat
  const nc = await probeNapcat();
  await handle(state, 'napcat', nc.ok, async () => {
    // 设过密码的话，先走「密码登录」：不弹二维码、不用碰手机
    // （只在 NapCat 进程活着、WebUI 能连上时才有意义）
    const pwdFile = path.join(ROOT, 'qq-password.dat');
    const qqLogin = path.join(ROOT, 'tools', 'qq-login.mjs');
    if (fs.existsSync(pwdFile) && fs.existsSync(qqLogin) && (await probePort(WEBUI_PORT))) {
      try {
        const out = execFileSync(process.execPath, [qqLogin, 'password'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 60000,
          env: { ...process.env, DSH_NO_HOT_RELOAD: '1' },
        });
        const last = String(out || '').trim().split('\n').filter(Boolean).pop() || '';
        if (last) log('密码登录：' + last.slice(0, 160));
      } catch (e) {
        const msg = String((e.stdout || '') + (e.stderr || '') || e.message).trim().split('\n').filter(Boolean).pop();
        log('密码登录失败：' + String(msg).slice(0, 160));

        // 退出码 2 = 要短信/验证码，3 = 要新设备扫码。
        // 这两种再重试只会让 QQ 风控更紧（今天就是这样从「能登」变成「要短信」的），
        // 所以直接停手、等人来，别每两分钟撞一次。
        if (e.status === 2 || e.status === 3) {
          const waitH = Number(process.env.HUMAN_WAIT_H || 2);
          s.pausedUntil = Date.now() + waitH * 3600 * 1000;
          const text = e.status === 2
            ? 'QQ 登录需要短信/验证码验证，自动重试已暂停。\n\n打开 NapCat WebUI（http://127.0.0.1:6099）完成验证，或用手机登录这个号后扫码。'
            : 'QQ 把这次登录判成「新设备」，需要扫码验证，自动重试已暂停。\n\n用登录着这个号的手机扫码（NapCat WebUI 里有二维码）。';
          if (Date.now() - s.alertedAt > ALERT_COOLDOWN_MS) {
            try { fs.writeFileSync(ALERT_FILE, `${new Date().toISOString()}\n${text}\n`); } catch {}
            desktopAlert(text);
            s.alertedAt = Date.now();
            s.alertedBy = 'QQ（NapCat）';
          }
          log(`停机等人处理，${waitH} 小时内不再自动尝试`);
          return false;
        }
      }
      await sleep(12000);
      if ((await probeNapcat()).ok) return true;
    }

    if (!fs.existsSync(BOOT_BAT)) {
      log('找不到 ' + BOOT_BAT);
      return false;
    }
    return spawnDetached('cmd.exe', ['/c', `"${BOOT_BAT}" -y`], { cwd: path.dirname(BOOT_BAT), windowsHide: false });
  }, {
    label: 'QQ（NapCat）',
    why: nc.why,
    manualHint: fs.existsSync(path.join(ROOT, 'qq-password.dat'))
      ? '密码登录也没成功：多半是 QQ 要短信/验证码或判了新设备（看 state/stack-doctor.log 里「密码登录」那行）。\n打开 NapCat WebUI（http://127.0.0.1:6099）按提示验证，验证完跑一次 node tools/qq-login.mjs password。'
      : '需要手动扫码：双击安装目录里的「测试快速登录.bat」；想免扫码就双击 tools\\set-qq-password.cmd 设一次密码',
  });

  // 2. 桥接（3000 没起来时桥接必然报错，不必重复判断）
  const bridgeUp = await probePort(3100);
  await handle(state, 'bridge', bridgeUp, () => {
    if (!fs.existsSync(BRIDGE_BAT)) return false;
    return launchAsUserVia(BRIDGE_BAT, '-y');
  }, { label: '桥接' });

  // 2.5 桥接「假活」：端口在、进程在、控制台也能调，但消息不处理。
  //     NapCat 日志里 1 小时内有收到私聊，桥接记录的 lastIncomingAt 却落后 5 分钟以上 → 判定卡住。
  const napcatDm = lastNapcatDmMs();
  const bridgeDm = bridgeLastIncomingMs();
  let stuck = false;
  // 桥接一次消息都没见过（0）时不能比：差值会等于"从 1970 年到现在"，
  // 2026-10-28 早上就因此误判成「29885746 分钟前的消息没处理」，白重启了一次桥接。
  if (napcatDm && bridgeDm > 0 && Date.now() - napcatDm < 60 * 60 * 1000) {
    const lagMin = (napcatDm - bridgeDm) / 60000;
    if (lagMin > 5 && lagMin < 24 * 60) {
      stuck = true;
      log(`NapCat ${Math.round(lagMin)} 分钟前收到过私聊，桥接没处理 → 判定假活`);
    }
  }
  await handle(state, 'bridgeStuck', !stuck, () => bridgeRestartViaApi(), {
    label: '桥接（收到消息没处理）',
    manualHint: '桥接卡住了，自动重启也没救回来。需要手动关掉桥接那个黑窗口，再双击安装目录里的「2-启动桥接.bat」。',
  });

  // 3. DSH 本体——启动文件夹里没有它，一关就全哑
  const dshUp = dshRunning();
  await handle(state, 'dsh', dshUp, () => {
    if (!fs.existsSync(DSH_EXE)) {
      log('找不到 ' + DSH_EXE);
      return false;
    }
    return launchAsUser(DSH_EXE);
  }, {
    label: 'DeepSeek Harness',
    manualHint: 'DeepSeek Harness 起不来，需要你看一眼。',
  });

  // 4. 后台脚本（supervisor + 一群 worker）
  //    supervisor 自己不留心跳，但 worker 每 20 秒刷锁；不新鲜的超过一半
  //    就说明这一层已经塌了（通常是 supervisor 静默退出），重新拉一遍。
  const fresh = freshWorkers();
  await handle(state, 'workers', fresh >= Math.ceil(WORKER_NAMES.length / 2), () => {
    if (!fs.existsSync(SUPERVISOR_BAT)) return false;
    return launchAsUserVia(SUPERVISOR_BAT, '-y');
  }, {
    label: '后台脚本',
    why: `${fresh}/${WORKER_NAMES.length} 个在跑`,
    manualHint: '后台脚本拉不起来，记忆/余额/定时任务会停。双击安装目录里的「20-supervisor.bat」',
  });

  saveState(state);

  // 心跳：一小时至少写一行，证明计划任务还在跑
  const hb = Date.now();
  if (!globalThis.__hb || hb - (state.__hbAt || 0) > HOUR) {
    log('全栈正常（心跳）');
    state.__hbAt = hb;
    saveState(state);
  }
}

main().catch((e) => {
  log('异常: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 0;
});
