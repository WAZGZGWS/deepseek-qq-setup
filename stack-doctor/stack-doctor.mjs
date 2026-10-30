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

/**
 * QQ 进程是不是已经在跑。
 *
 * 为什么要这个：NapCat 登录要几十秒，这段时间 3000 还没起来，
 * 看门狗会以为「没在跑」又去拉一个 —— 结果两个实例用同一个号互相顶号，
 * 表现就是「她老是掉线、刚登上就被踢」（2026-10-28 晚上实际撞到两次）。
 */
function qqRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    return /QQ\.exe/i.test(out);
  } catch {
    return false;
  }
}

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
      // 发过「掉线」邮件的话，恢复时补一封「回来了」——
      // 否则他不知道她是自己回来的，还是还躺着（一封邮件几分钱，换一个安心）。
      if (label === 'QQ（NapCat）') {
        const downMin = s.downSince ? Math.round((Date.now() - s.downSince) / 60000) : 0;
        mailOffline('【她回来了】QQ 已恢复登录', `她已经重新登录了${downMin ? `，这次掉了 ${downMin} 分钟` : ''}。\n\n不用你做什么，消息照常回。`);
      }
    }
    s.fails = 0;
    s.downSince = 0;
    s.pausedUntil = 0;
    s.starts = s.starts.filter((t) => t > Date.now() - RETRY_WINDOW);
    // 验证链接是一次性的：登进去了就删掉，免得以后点开一个早就失效的旧链接
    try { fs.unlinkSync(path.join(STATE_DIR, 'qq-verify-link.txt')); } catch {}
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
  if (await restartFn(s)) {
    s.lastStart = Date.now();
    s.starts.push(Date.now());
    log(`${label} 已拉起（近 ${RETRY_WINDOW_H} 小时第 ${s.starts.length} 次）`);
  }
  s.fails = 0;
}

/**
 * 让「一闪而过的黑框」消失。
 *
 * 计划任务的动作用 cmd.exe 直接跑 .cmd/.bat 时，Task Scheduler 会真的建一个
 * 控制台窗口 —— 脚本跑多久它亮多久。2026-10-29 抓到实锤：每 2 分钟的
 * QQStackDoctor 在 09:53:06 弹出一个可见 cmd 窗口（父进程 svchost = 计划任务服务）。
 *
 * 改法：动作换成 `wscript.exe run-hidden.vbs <脚本>`，窗口样式 0 = 完全不显示。
 * 改任务要管理员，而本脚本自己就是计划任务里以 Highest 权限在跑 —— 顺手把
 * 自家和同批任务（巡检/日报/维护）一起换掉；没提权就静默跳过。
 * 6 小时查一次就够，别每 2 分钟都去问一遍计划任务。
 */
function ensureSilentTasks(state) {
  const VBS = path.join(ROOT, 'run-hidden.vbs');
  if (!fs.existsSync(VBS)) return;
  if (Date.now() - (state.__silentTaskAt || 0) < 6 * HOUR) return;
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
  } catch {
    return; // 没提权：改不动 Highest 任务，等下次
  }
  state.__silentTaskAt = Date.now();

  const ps = [
    "$vbs = $env:QQ_VBS; $root = $env:QQ_ROOT",
    "$map = [ordered]@{ 'QQStackDoctor' = 'stack-doctor.cmd'; 'PatrolAt0900' = '16-patrol.bat'; 'PatrolAt2100' = '16-patrol.bat'; 'DailyReportAt2300' = '10-daily-report.bat'; 'MaintenanceDailyAt0400' = '13-maintenance.bat' }",
    "foreach ($n in $map.Keys) {",
    "  $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue; if (-not $t) { continue }",
    "  $cur = ($t.Actions | ForEach-Object { \"$($_.Execute) $($_.Arguments)\" }) -join ';'",
    "  if ($cur -match 'run-hidden\\.vbs') { continue }",
    "  $target = Join-Path $root $map[$n]; if (-not (Test-Path $target)) { continue }",
    "  $arg = '\"' + $vbs + '\" \"' + $target + '\"'",
    "  try {",
    "    $a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $arg -ErrorAction Stop",
    "    Set-ScheduledTask -TaskName $n -Action $a -ErrorAction Stop | Out-Null",
    "    $back = ((Get-ScheduledTask -TaskName $n).Actions | ForEach-Object { \"$($_.Execute) $($_.Arguments)\" }) -join ';'",
    "    if ($back -match 'run-hidden\\.vbs') { \"OK $n\" } else { \"FAIL $n\" }",
    "  } catch { \"ERR $n $($_.Exception.Message)\" }",
    "}",
  ].join('\n');

  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
      env: { ...process.env, QQ_VBS: VBS, QQ_ROOT: ROOT },
    });
    for (const line of String(out || '').split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (line.startsWith('OK ')) log(`计划任务 ${line.slice(3)} 改成静默启动（不再闪黑框）`);
      else log(`计划任务静默化没成功：${line}`);
    }
  } catch (e) {
    log('计划任务静默化出错：' + String(e.message || e).slice(0, 140));
  }
}

/**
 * 短信验证链接只跟「那一次」登录请求的 sid 绑定：脚本一退出，链接就作废。
 * 所以这里再拉一个后台登录进程，让它带着长时间轮询等人验证，
 * 顺便把链接写进 state/qq-verify-link.txt（桌面通知里也带上）。
 * 返回拿到的链接；拿不到就返回空串，外层会退化成「去 WebUI」的说法。
 */
async function startVerifyPoller(qqLogin) {
  const linkFile = path.join(STATE_DIR, 'qq-verify-link.txt');
  const pollLog = path.join(STATE_DIR, 'qq-verify.log');
  try { fs.unlinkSync(linkFile); } catch {}
  const waitSec = Number(process.env.VERIFY_WAIT_SEC || 1800);
  try {
    const out = fs.openSync(pollLog, 'w');
    const child = spawn(process.execPath, [qqLogin, 'password'], {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, WAIT_SEC: String(waitSec), DSH_NO_HOT_RELOAD: '1' },
    });
    child.unref();
  } catch (e) {
    log('起后台验证进程失败：' + String(e.message || e).slice(0, 120));
    return '';
  }
  // 它先打链接再开始轮询，最多等 15 秒
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const m = /https:\/\/ti\.qq\.com\/\S+/.exec(fs.readFileSync(pollLog, 'utf8'));
      if (m) {
        try { fs.writeFileSync(linkFile, `${new Date().toISOString()}\n${m[0]}\n`); } catch {}
        log(`短信验证链接已落盘（state/qq-verify-link.txt），后台等人工验证，最多 ${Math.round(waitSec / 60)} 分钟`);
        return m[0];
      }
    } catch {}
    await sleep(500);
  }
  log('后台验证进程没吐出链接（可能密码/账号有问题），去看 state/qq-verify.log');
  return '';
}

/**
 * 让 NapCat 的登录二维码落到本地 PNG。
 * 哥的原话是「扫码最麻烦」——麻烦的其实是开浏览器、输 WebUI token、再找登录页。
 * 二维码内容就是一条 URL，我们自己画成 PNG，双击或在聊天里发一下就能扫。
 */
function renderQrFile() {
  try {
    const tool = path.join(ROOT, 'tools', 'show-qr.mjs');
    if (!fs.existsSync(tool)) return '';
    const out = execFileSync(process.execPath, [tool], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const line = String(out || '').split('\n').find((l) => l.includes('二维码已生成'));
    return line ? line.replace(/^.*二维码已生成：/, '').trim() : '';
  } catch {
    return '';
  }
}

/**
 * 用邮件把话说出去（QQ 之外的通道）。
 *
 * 场景：她掉线、要验证，这时候她在 QQ 上**一个字都发不出来**，桌面通知哥在上班也看不见。
 * 邮件不依赖 QQ 登录状态，能落到手机上；验证链接在手机浏览器里就能点完。
 * 没设授权码时安静失败，只在日志里说一句（不能因为邮件失败把巡检弄崩）。
 */
function mailOffline(subject, body, attachPath = '') {
  try {
    const tool = path.join(ROOT, 'tools', 'notify-offline.mjs');
    if (!fs.existsSync(tool)) return false;
    const bodyFile = path.join(STATE_DIR, 'notify-body.txt');
    fs.writeFileSync(bodyFile, String(body || '') + '\n', 'utf8');
    const args = [tool, `--subject=${subject}`, `--body-file=${bodyFile}`];
    if (attachPath && fs.existsSync(attachPath)) args.push(`--attach=${attachPath}`);
    execFileSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const state = loadState();

  // 0. 先把「闪黑框」的计划任务改成静默（提权时才做，见函数注释）
  ensureSilentTasks(state);

  // 1. NapCat
  const nc = await probeNapcat();
  await handle(state, 'napcat', nc.ok, async (st) => {
    // 设过密码的话，先走「密码登录」：不弹二维码、不用碰手机
    // （只在 NapCat 进程活着、WebUI 能连上时才有意义）
    const pwdFile = path.join(ROOT, 'qq-password.dat');
    const qqLogin = path.join(ROOT, 'tools', 'qq-login.mjs');
    if (fs.existsSync(pwdFile) && fs.existsSync(qqLogin) && (await probePort(WEBUI_PORT))) {
      // 0) 先试「快速登录」：用本机缓存 ticket，不碰密码、不会触发短信验证。
      //    下午被服务端踢下线时这一步最关键 —— 成了她自己就回来了，不用等人。
      try {
        const out = execFileSync(process.execPath, [qqLogin, 'quick'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 150000,
          env: { ...process.env, DSH_NO_HOT_RELOAD: '1' },
        });
        const last = String(out || '').trim().split('\n').filter(Boolean).pop() || '';
        if (last) log('快速登录：' + last.slice(0, 160));
        if ((await probeNapcat()).ok) return true;
      } catch (e) {
        const msg = String((e.stdout || '') + (e.stderr || '') || e.message).trim().split('\n').filter(Boolean).pop();
        log('快速登录没成：' + String(msg).slice(0, 160));
      }
      // 1) 再走密码登录
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
          const waitH = Number(process.env.HUMAN_WAIT_H || 6);
          st.pausedUntil = Date.now() + waitH * 3600 * 1000;
          // 二合一：**一封邮件里同时给**「短信验证链接」和「二维码」，哪个来得及用哪个。
          // 哥在上班，没法来回要好几次；短信链接有 30 分钟窗口，二维码只有几分钟，
          // 所以正文里明确写清谁能撑多久。
          const smsLink = e.status === 2 ? await startVerifyPoller(qqLogin) : '';
          const qrPath = renderQrFile();
          let qrUrl = '';
          try { qrUrl = String(fs.readFileSync(path.join(STATE_DIR, 'napcat-qrcode.txt'), 'utf8')).trim().split('\n')[0]; } catch {}
          const parts = [];
          parts.push(e.status === 2 ? 'QQ 要短信验证（自动重试已暂停）。' : 'QQ 判「新设备」，要扫码（自动重试已暂停）。');
          if (smsLink) parts.push(`① 短信验证（30 分钟内有效，**推荐**）：\n${smsLink}\n→ 点开、收验证码、填进去；后台正在等她回来。`);
          if (qrUrl) parts.push(`② 扫码（二维码几分钟就过期，赶不上就用①）：\n${qrUrl}\n→ 有另一台设备就用相机扫；没有就直接点这条，通常会唤起 QQ 让你确认。`);
          if (qrPath) parts.push(`二维码图片在附件里（本机也留了一份：${qrPath}）。`);
          if (!smsLink && !qrUrl) parts.push('两种都没拿到：打开 NapCat WebUI（http://127.0.0.1:6099）手动处理。');
          const text = parts.join('\n\n');
          const qrAttach = qrPath;
          if (Date.now() - st.alertedAt > ALERT_COOLDOWN_MS) {
            try { fs.writeFileSync(ALERT_FILE, `${new Date().toISOString()}\n${text}\n`); } catch {}
            desktopAlert(text);
            // 她这时候说不了话（QQ 掉着），桌面通知哥也看不见 —— 用邮件把消息送到手机上。
            // 链接在手机上就能完成验证：点开 → 收短信 → 填 → 后台的轮询会把她接回来。
            const mailOk = mailOffline('【她掉线了】QQ 要验证，手机点链接就能救回来', text, typeof qrAttach === 'string' ? qrAttach : '');
            log(mailOk ? '已发邮件通知（QQ 外的通道）' : '邮件通知没发出去（检查 tools/set-mail-auth.cmd 有没有设过）');
            st.alertedAt = Date.now();
            st.alertedBy = 'QQ（NapCat）';
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
    // QQ 已经在跑就别再开一个：登录要几十秒，这期间 3000 是空的，
    // 再拉一个实例只会跟它抢同一个号（互踢）。
    if (qqRunning()) {
      log('QQ 进程已经在跑（可能正在登录），不再开第二个，等下一轮');
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

  // 4.5 保持唤醒：它一死，机器迟早自己睡，QQ 跟着掉。
  // 2026-10-29 的实锤：这个进程悄悄没了没人发现，中午合盖后就进了 Modern Standby，
  // 一掉 10 小时。现在靠 4-hold-awake.ps1 每 30 秒写的状态心跳判活，不新鲜就重拉。
  const hbFile = path.join(STATE_DIR, 'keep-awake.heartbeat');
  let beatMs = Infinity;
  try { beatMs = Date.now() - fs.statSync(hbFile).mtimeMs; } catch {}
  const keepAwakeUp = beatMs < 90 * 1000;
  await handle(state, 'keepAwake', keepAwakeUp, () => {
    const vbs = path.join(ROOT, 'keep-awake.vbs');
    if (!fs.existsSync(vbs)) {
      log('找不到 keep-awake.vbs，没法拉起保持唤醒');
      return false;
    }
    return spawnDetached('wscript.exe', [vbs], { cwd: ROOT });
  }, {
    label: '保持唤醒',
    why: Number.isFinite(beatMs) ? `心跳 ${Math.round(beatMs / 1000)} 秒前` : '没有心跳文件',
    manualHint: '保持唤醒没起来，机器可能会自己睡眠、QQ 跟着掉线。双击安装目录里的 4-hold-awake.ps1 可以手动顶住。',
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
