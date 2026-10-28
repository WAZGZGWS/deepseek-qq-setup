#!/usr/bin/env node
/**
 * qq-login —— 不用手机扫码，直接用账号密码把 QQ 登回去
 *
 * 为什么需要它：
 *   QQ 掉线后（KickedOffLine「登录已失效」），快速登录凭证会跟着失效。
 *   常规做法是弹二维码，用手机 QQ 扫 —— 但手机上是哥自己的号，
 *   要扫就得切号，很烦。
 *
 *   NapCat 的 WebUI 其实开放了密码登录接口（`/api/QQLogin/PasswordLogin`），
 *   只要本地存了「大肥鱼」的密码，就能一条命令登回去，全程不碰手机。
 *
 * 用法：
 *   node tools/qq-login.mjs status      看现在登录没有、登的是谁
 *   node tools/qq-login.mjs password    用存好的密码登录（密码见 set-qq-password.ps1）
 *   node tools/qq-login.mjs qr          拿一张二维码图片（真要扫码时用）
 *
 * 密码存哪：
 *   本目录下的 qq-password.dat，用 Windows DPAPI 按「当前用户」加密，
 *   只有这台电脑上的你这个账户能解开；拷到别的机器/别的账户都读不出来。
 *   设置/更换密码：双击 `tools/set-qq-password.cmd`（输入时不回显）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT, readJson } from '../lib/base.mjs';

const NAPCAT = path.join(ROOT, 'napcat', 'napcat');
const PWD_FILE = path.join(ROOT, 'qq-password.dat');
const QR_FILE = path.join(ROOT, 'state', 'napcat-qrcode.png');
const webui = readJson(path.join(NAPCAT, 'config', 'webui.json'), {});
const BASE = `http://127.0.0.1:${webui.port || 6099}`;

/** 机器人的 QQ 号：从启动脚本里的 `-q 123456` 读，不写死 */
function botUin() {
  for (const f of ['napcat-boot.bat', '测试快速登录.bat', '1-启动NapCat.bat']) {
    try {
      const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const m = t.match(/-q\s+(\d{5,12})/);
      if (m) return m[1];
    } catch {}
  }
  return '';
}

/** WebUI 登录：hash = sha256(token + ".napcat")，返回凭据 */
async function auth() {
  if (!webui.token) throw new Error('读不到 napcat/config/webui.json 里的 token');
  const hash = crypto.createHash('sha256').update(webui.token + '.napcat').digest('hex');
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hash }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json();
  const cred = j?.data?.Credential;
  if (!cred) throw new Error(`WebUI 登录失败：${j?.message || r.status}`);
  return cred;
}

async function call(cred, p, body = {}) {
  const r = await fetch(`${BASE}/api/QQLogin${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cred}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; }
}

/** 用 DPAPI 解出密码（只有当前 Windows 用户能解） */
function readPassword() {
  if (!fs.existsSync(PWD_FILE)) {
    throw new Error('还没有设置密码：先双击 tools/set-qq-password.cmd（输入时不回显）');
  }
  const ps = [
    'Add-Type -AssemblyName System.Security;',
    '$b=[IO.File]::ReadAllBytes(' + JSON.stringify(PWD_FILE) + ');',
    '$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,"CurrentUser");',
    '[Text.Encoding]::UTF8.GetString($p)',
  ].join(' ');
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  const pwd = String(out || '').replace(/\r?\n$/, '');
  if (!pwd) throw new Error('密码解密出来是空的，重新设置一次');
  return pwd;
}

/** 3000 端口才是「真的登进去了」的判据：WebUI 的 CheckLoginStatus 只代表它自己那路 */
async function oneBotLogin() {
  try {
    const r = await fetch('http://127.0.0.1:3000/get_login_info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    const d = j?.data || {};
    if (d.user_id) return { uin: String(d.user_id), nick: String(d.nickname || '') };
  } catch {}
  return null;
}

async function status() {
  const live = await oneBotLogin();
  if (live) {
    console.log(`已登录：${live.uin} ${live.nick}`);
  } else {
    try {
      const cred = await auth();
      const res = await call(cred, '/CheckLoginStatus');
      const d = res?.data || {};
      console.log(`未登录（阶段：${d.loginPhase || '?'}${d.loginError ? '，错误：' + d.loginError : ''}）`);
      if (d.qrcodeurl) console.log('当前二维码链接：', d.qrcodeurl);
    } catch (e) {
      console.log('NapCat 没在跑（3000/6099 都连不上）：', e.message);
    }
  }
  try {
    const cred = await auth();
    const list = await call(cred, '/GetQuickLoginList');
    if (Array.isArray(list?.data)) console.log('本机快速登录过的号：', list.data.join(', '));
  } catch {}
  return Boolean(live);
}

async function passwordLogin() {
  if (await oneBotLogin()) {
    console.log('已经登录着，不用再登');
    return true;
  }
  const uin = botUin();
  if (!uin) throw new Error('没从启动脚本里找到机器人 QQ 号（找 `-q <号>`）');
  const md5 = crypto.createHash('md5').update(readPassword()).digest('hex');
  const cred = await auth();
  const res = await call(cred, '/PasswordLogin', { uin, passwordMd5: md5 });
  if (res?.code === 0) {
    console.log(`密码登录请求已发送（${uin}），等 5~20 秒看 3000 端口/日志`);
    return true;
  }
  if (res?.data?.needCaptcha) {
    console.log('需要安全验证（滑块/验证码）：', res.data.proofWaterUrl || '');
    console.log('这一步只能人工过：打开 NapCat WebUI → 密码登录 → 按提示验证');
    return false;
  }
  if (res?.data?.needNewDevice) {
    console.log('QQ 判定为「新设备」，需要扫码验证：', res.data.jumpUrl || '');
    console.log('打开 NapCat WebUI 按提示处理，或 tools/qq-login.mjs qr 拿二维码');
    return false;
  }
  console.log('登录失败：', res?.message || JSON.stringify(res).slice(0, 200));
  return false;
}

async function qr() {
  if (await oneBotLogin()) {
    console.log('已经登录着，不需要二维码');
    return true;
  }
  const cred = await auth();
  const res = await call(cred, '/CheckLoginStatus');
  const url = res?.data?.qrcodeurl || '';
  if (!url) { console.log('拿不到二维码：', JSON.stringify(res).slice(0, 200)); return false; }
  // NapCat 给的是一条 https 链接（QQ 的二维码落地页），不是图片；存下来方便点开
  fs.mkdirSync(path.dirname(QR_FILE), { recursive: true });
  fs.writeFileSync(QR_FILE.replace(/\.png$/, '.txt'), url + '\n', 'utf8');
  console.log('二维码链接：', url);
  console.log('（扫它需要手机上登录的是机器人那个号，所以你多半用不上这条）');
  return true;
}

const cmd = process.argv[2] || 'status';
try {
  if (cmd === 'status') await status();
  else if (cmd === 'password') await passwordLogin();
  else if (cmd === 'qr') await qr();
  else console.log('用法: node tools/qq-login.mjs [status|password|qr]');
} catch (e) {
  console.error('出错:', e.message);
  process.exitCode = 1;
}
