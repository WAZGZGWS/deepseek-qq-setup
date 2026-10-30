#!/usr/bin/env node
/**
 * show-qr —— 把 NapCat 的登录二维码**生成 PNG 放在本地**，直接扫屏幕就行。
 *
 * 为什么做这个：
 *   以前要扫码得：打开浏览器 → 输 WebUI token → 找到登录页 → 对着屏幕扫。
 *   哥的原话是「扫码这个最麻烦」。其实二维码内容就是个 URL，我们自己能画出来 ——
 *   画成 PNG 之后，随便哪个窗口显示一下就能扫，不用碰 WebUI。
 *
 * 用法：
 *   node tools/show-qr.mjs             从 NapCat 取当前二维码链接 → 画 PNG
 *   node tools/show-qr.mjs --open      画完用系统看图器打开
 *   node tools/show-qr.mjs --url=xxx   直接画指定的二维码内容（离线调试用）
 *
 * 依赖：tools/qr/node_modules/qrcode（本地安装，不走网络）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(path.join(HERE, 'qr', 'node_modules', 'x.js'));

let QRCode;
try {
  QRCode = require('qrcode');
} catch {
  console.error('没找到 qrcode 库（tools/qr/node_modules/qrcode），先跑一次 npm install');
  process.exit(1);
}

const OUT = path.join(ROOT, 'state', 'napcat-qrcode.png');
const TOKEN_FILE = path.join(ROOT, 'napcat', 'napcat', 'config', 'webui.json');

const argUrl = (process.argv.find((a) => a.startsWith('--url=')) || '').slice(6);

/** WebUI token：从 webui.json 读（被改过也能拿到最新的） */
function webuiToken() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return String(j.token || '').trim();
  } catch { return ''; }
}

async function napcatAuth() {
  const token = webuiToken();
  if (!token) throw new Error('读不到 WebUI token（napcat/napcat/config/webui.json）');
  const hash = crypto.createHash('sha256').update(token + '.napcat').digest('hex');
  const r = await fetch('http://127.0.0.1:6099/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hash }),
  });
  const j = await r.json();
  const cred = j?.data?.Credential;
  if (!cred) throw new Error('WebUI 登录失败：' + (j?.message || r.status));
  return cred;
}

async function currentQrUrl() {
  const cred = await napcatAuth();
  const r = await fetch('http://127.0.0.1:6099/api/QQLogin/CheckLoginStatus', {
    headers: { authorization: `Bearer ${cred}` },
  });
  const j = await r.json();
  const d = j?.data || {};
  if (d.isLogin) throw new Error('现在已经登录着，不需要扫码');
  const url = String(d.qrcodeurl || '').trim();
  if (!url) throw new Error('NapCat 现在没给二维码（可能正在重启/连不上）');
  return url;
}

const url = argUrl || (await currentQrUrl().catch((e) => { console.error('拿二维码失败：' + e.message); process.exit(2); }));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
await QRCode.toFile(OUT, url, { width: 480, margin: 2, errorCorrectionLevel: 'M' });

// 顺手留一份链接，方便排查（不额外发出去）
try { fs.writeFileSync(OUT.replace(/\.png$/, '.txt'), url + '\n', 'utf8'); } catch {}

console.log('二维码已生成：' + OUT);
console.log('内容：' + url);

if (process.argv.includes('--open')) {
  try { execFileSync('explorer.exe', [OUT], { windowsHide: false }); } catch {}
}
