#!/usr/bin/env node
/**
 * qr-screen —— 把「扫码黑屏」拉起来（主脑判断要扫码时调它）。
 *
 * 场景：QQ 掉登录 / 二维码过期，哥在电脑前，最省事的是屏幕上直接出现一张黑底大二维码，
 * 掏手机扫完就完事 —— 不用开浏览器、不用输 token、不用找人要链接。
 *
 * 它只做两件事：
 *   1. 确保扫码页服务在跑（tools/qr-live.mjs，黑底大二维码，码会自己刷新）；
 *   2. 在用户会话里用 Edge/Chrome 的应用窗口打开它。
 *
 * 「窗口到底起来没有」不能看进程 —— 浏览器经常「启动器进程立刻退出、窗口交给已有实例」，
 * 所以看扫码页的 /hits：页面被真的访问过，才算亮起来了。
 *
 * 端口：7788 可能被一个「老版本、没有 /hits」的扫码页占着（起太早又杀不掉时就是这情况），
 * 所以先找带 /hits 的，找不到就在 7790 自己起一个。
 *
 * 用法：
 *   node tools/qr-screen.mjs            打开（幂等）
 *   node tools/qr-screen.mjs --close    关掉
 *   node tools/qr-screen.mjs --status   上次什么时候亮的
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { ROOT, STATE, portOpen } from '../lib/base.mjs';

const STATE_FILE = path.join(STATE, 'qr-screen.json');
const PID_FILE = path.join(STATE, 'qr-screen.pid');
const LOG_FILE = path.join(STATE, 'qr-screen.log');
const PORTS = [7788, 7790];
const FALLBACK_PORT = 7790;
let BASE = 'http://127.0.0.1:7788';

const ARGS = process.argv.slice(2);
const CLOSE = ARGS.includes('--close');
const STATUS = ARGS.includes('--status');

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}] ${msg}\n`); } catch {}
}
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }
function readPid() { try { return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || 0; } catch { return 0; } }
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 8000 }); return true; } catch { return false; }
}

function findBrowser() {
  const bases = [
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    process.env.ProgramFiles || 'C:\\Program Files',
  ];
  const cands = [];
  for (const b of bases) {
    cands.push(path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    cands.push(path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch {} }
  return '';
}

async function hitsOn(base) {
  try {
    const r = await fetch(base + '/hits', { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return -1;
    const j = await r.json();
    return Number(j.hits) || 0;
  } catch { return -1; }
}

/** 找一个能用的扫码页：优先已经跑着且带 /hits 的，否则自己在备用端口起一个 */
async function ensureQrServer() {
  for (const p of PORTS) {
    if (!(await portOpen(p).catch(() => false))) continue;
    const base = `http://127.0.0.1:${p}`;
    if ((await hitsOn(base)) >= 0) { BASE = base; return true; }
  }
  const port = FALLBACK_PORT;
  if (!(await portOpen(port).catch(() => false))) {
    try {
      const out = fs.openSync(path.join(STATE, 'qr-live.log'), 'a');
      const c = spawn(process.execPath, [path.join(ROOT, 'tools', 'qr-live.mjs'), `--port=${port}`], {
        cwd: ROOT, stdio: ['ignore', out, out], windowsHide: true, detached: true,
      });
      c.unref();
      try { fs.closeSync(out); } catch {}
      log(`拉起扫码页服务 pid=${c.pid} :${port}`);
    } catch (e) { log('拉扫码页失败：' + e.message); }
  }
  for (let i = 0; i < 25; i += 1) {
    await new Promise((r) => setTimeout(r, 300));
    if ((await hitsOn(`http://127.0.0.1:${port}`)) >= 0) { BASE = `http://127.0.0.1:${port}`; return true; }
  }
  return false;
}

async function open() {
  if (!(await ensureQrServer())) { console.log('扫码页起不来'); log('扫码页起不来'); return 1; }
  const before = await hitsOn(BASE);
  if (before < 0) { console.log('扫码页服务连不上'); return 1; }

  const st = readState();
  if (st.openedAt && Date.now() - Date.parse(st.openedAt) < 30000 && before > 0) {
    console.log(`扫码黑屏刚亮过（页面访问 ${before} 次），不重复开`);
    return 0;
  }

  // 用 PowerShell WinForms 画一块真·黑屏（不用浏览器：这台机器上从脚本里拉浏览器
  // 经常「进程起来了但页面没访问到」，而 WinForms 窗口在用户会话里一定看得见）。
  const hb = path.join(STATE, 'qr-black.json');
  try { fs.unlinkSync(hb); } catch {}
  const port = Number(BASE.split(':').pop()) || 7788;
  let via = 'winforms';
  try {
    const c = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(ROOT, 'tools', 'qr-black.ps1'),
      '-Port', String(port),
      '-StateDir', STATE,
    ], { cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: true });
    c.unref();
    if (c.pid) { try { fs.writeFileSync(PID_FILE, String(c.pid)); } catch {} }
  } catch (e) { via = ''; log('起黑屏失败：' + e.message); }

  // 判定「真亮起来了」：它每 3 秒写一次心跳，心跳出现才算窗口起来了
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    let beat = null;
    try { beat = JSON.parse(fs.readFileSync(hb, 'utf8')); } catch {}
    if (beat && Date.now() - Date.parse(beat.at) < 15000) {
      writeState({ openedAt: new Date().toISOString(), via, url: BASE, pid: beat.pid || readPid() });
      console.log(`扫码黑屏已亮起（黑底大二维码，${BASE}）`);
      log(`亮起 via=${via} url=${BASE} pid=${beat.pid}`);
      return 0;
    }
  }
  console.log('黑屏没起来（没有心跳）');
  log('拉起失败：没有心跳');
  return 1;
}

function close() {
  const pid = readPid();
  if (pid && pidAlive(pid)) killTree(pid);
  try { fs.unlinkSync(PID_FILE); } catch {}
  writeState({ openedAt: '', closedAt: new Date().toISOString() });
  console.log('已关掉扫码黑屏（窗口若还在，登录成功后页面自己会显示「已登录」）');
  log('关闭扫码黑屏');
  return 0;
}

if (STATUS) {
  const st = readState();
  if (!st.openedAt) console.log('还没亮过');
  else {
    const at = new Date(st.openedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    console.log(`上次亮起 ${at}（${st.via || '未知'}，${st.url || ''}，访问 ${st.hitsAfter || 0} 次）`);
  }
  process.exit(0);
}
process.exit(CLOSE ? close() : await open());
