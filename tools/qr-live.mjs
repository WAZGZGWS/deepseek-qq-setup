#!/usr/bin/env node
/**
 * qr-live —— 一个会自己刷新的登录二维码页面（本地，127.0.0.1，不对外）。
 *
 * 为什么做：NapCat 的登录二维码只有两三分钟寿命。用图片发给人的结果就是
 * 「每次扫都提示已过期」。这个页面在浏览器里自己盯着：过期前自动刷新二维码，
 * 并且实时显示「扫了没 / 登进去没」。
 *
 * 用法：node tools/qr-live.mjs [--port=7788]
 * 然后浏览器打开 http://127.0.0.1:7788
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(path.join(HERE, 'qr', 'node_modules', 'x.js'));
const QRCode = require('qrcode');

const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').slice(7)) || 7788;
const WEBUI = 'http://127.0.0.1:6099';
const WEBUI_CFG = path.join(ROOT, 'napcat', 'napcat', 'config', 'webui.json');

let cred = '';
let qrUrl = '';
let qrAt = 0;          // 当前二维码生成时间
let pngCache = null;
let lastError = '';

function webuiToken() {
  try { return String(JSON.parse(fs.readFileSync(WEBUI_CFG, 'utf8')).token || '').trim(); } catch { return ''; }
}

async function auth() {
  if (cred) return cred;
  const token = webuiToken();
  if (!token) throw new Error('读不到 WebUI token');
  const hash = crypto.createHash('sha256').update(token + '.napcat').digest('hex');
  const r = await fetch(WEBUI + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash }),
  });
  const j = await r.json();
  cred = j?.data?.Credential || '';
  if (!cred) throw new Error('WebUI 登录失败：' + (j?.message || r.status));
  return cred;
}

/** 取状态；可选刷新二维码 */
async function status(refresh = false) {
  const c = await auth();
  if (refresh) {
    const r = await fetch(WEBUI + '/api/QQLogin/RefreshQRcode', {
      method: 'POST', headers: { authorization: `Bearer ${c}`, 'content-type': 'application/json' }, body: '{}',
    });
    const j = await r.json();
    const url = String(j?.data?.qrcodeurl || '').trim();
    if (url) { qrUrl = url; qrAt = Date.now(); pngCache = null; }
  }
  // NapCat 这个接口只认 POST：GET 会返回一段 HTML，JSON.parse 直接炸（500 就是这么来的）
  const r = await fetch(WEBUI + '/api/QQLogin/CheckLoginStatus', {
    method: 'POST',
    headers: { authorization: `Bearer ${c}`, 'content-type': 'application/json' },
    body: '{}',
  });
  const j = await r.json();
  const d = j?.data || {};
  if (d.qrcodeurl && d.qrcodeurl !== qrUrl) { qrUrl = String(d.qrcodeurl).trim(); qrAt = Date.now(); pngCache = null; }
  return { logged: !!d.isLogin, url: qrUrl, ageSec: qrAt ? Math.round((Date.now() - qrAt) / 1000) : -1, error: lastError };
}

function page() {
  return `<!doctype html><meta charset="utf-8"><title>扫码登录（自动刷新）</title>
<style>
 body{background:#111;color:#eee;font-family:system-ui,"Microsoft YaHei";display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0}
 #qr{background:#fff;padding:12px;border-radius:12px}
 #st{margin-top:14px;font-size:16px}
 .ok{color:#4ade80} .warn{color:#fbbf24}
</style>
<div id="qr"><img id="img" width="360" height="360" alt="正在加载…"></div>
<div id="st">正在连接 NapCat…</div>
<script>
let lastUrl = '';
async function tick() {
  try {
    const r = await fetch('/status?t=' + Date.now());
    const j = await r.json();
    const st = document.getElementById('st');
    if (j.logged) {
      st.className = 'ok';
      st.textContent = '✅ 已登录，这个页面可以关了';
    } else if (j.error) {
      st.className = 'warn';
      st.textContent = '⚠️ ' + j.error;
    } else {
      st.className = '';
      st.textContent = '二维码第 ' + j.ageSec + ' 秒（超过 90 秒自动换新），用手机 QQ 扫一下';
    }
    if (j.url && j.url !== lastUrl) {
      lastUrl = j.url;
      document.getElementById('img').src = '/qr.png?t=' + Date.now();
    }
  } catch (e) { document.getElementById('st').textContent = '连不上本地服务：' + e.message; }
}
tick(); setInterval(tick, 3000);
</script>`;
}

// 页面被打开过几次：主脑据此确认「黑屏真的亮起来了」，而不是只看拉没拉起进程
let pageHits = 0;
let lastHitAt = 0;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page());
    }
    if (url.pathname === '/hits') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ hits: pageHits, lastHitAt }));
    }
    if (url.pathname === '/status') {
      // 二维码超过 90 秒就自动刷新（页面每 3 秒问一次，相当于有人看着）
      const stale = !qrAt || Date.now() - qrAt > 90 * 1000;
      const st = await status(stale);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(st));
    }
    if (url.pathname === '/qr.png') {
      const st = await status(false);
      if (!st.url) throw new Error('NapCat 还没给二维码');
      if (!pngCache || pngCache.url !== st.url) {
        pngCache = { url: st.url, buf: await QRCode.toBuffer(st.url, { width: 480, margin: 2, errorCorrectionLevel: 'M' }) };
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return res.end(pngCache.buf);
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    lastError = String(e.message || e).slice(0, 120);
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: lastError }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`扫码页已启动：http://127.0.0.1:${PORT} （二维码会自己刷新，扫的时候不会过期）`);
});
