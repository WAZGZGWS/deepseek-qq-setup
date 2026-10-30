#!/usr/bin/env node
/**
 * notify-offline —— 她「说不了话」的时候，用** QQ 以外的通道**把消息送到哥手机上。
 *
 * 为什么需要它：她唯一能说话的通道就是 QQ。QQ 被踢/要验证时，她连一句「我掉线了」
 * 都发不出去，所以那条验证链接永远只能躺在电脑本地 —— 哥要是在上班，就只能等晚上回来。
 * 邮件的意义就在这：它不依赖 QQ 登录状态。
 *
 * 用法：
 *   node tools/notify-offline.mjs --test                    发一封测试邮件
 *   node tools/notify-offline.mjs --subject=.. --body=..    发指定内容
 *   node tools/notify-offline.mjs --body-file=state/qq-verify-link.txt
 *
 * 凭据：qq-mail-auth.dat（DPAPI 加密，用 tools/set-mail-auth.cmd 设一次）
 * 收件人：2969862040@qq.com（可用环境变量 QQ_MAIL_TO 覆盖）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(path.join(HERE, 'mail', 'node_modules', 'x.js'));

let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch {
  console.error('没找到 nodemailer（tools/mail/node_modules），先 npm install --prefix tools/mail');
  process.exit(1);
}

const USER = process.env.QQ_MAIL_USER || '2969862040@qq.com';
const TO = process.env.QQ_MAIL_TO || '2969862040@qq.com';
const AUTH_FILE = path.join(ROOT, 'qq-mail-auth.dat');
const LOG = path.join(ROOT, 'state', 'notify-offline.log');

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

/** 授权码：DPAPI 解出来的，跟 qq-password.dat 同一套做法（不落明文） */
function readAuth() {
  if (process.env.QQ_MAIL_AUTH) return process.env.QQ_MAIL_AUTH.trim();
  if (!fs.existsSync(AUTH_FILE)) return '';
  try {
    const b64 = fs.readFileSync(AUTH_FILE, 'utf8').trim();
    const ps = [
      'Add-Type -AssemblyName System.Security',
      `$b=[Convert]::FromBase64String('${b64}')`,
      '$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      '[Text.Encoding]::UTF8.GetString($p)',
    ].join('; ');
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
  } catch (e) {
    log('解授权码失败：' + String(e.message || e).slice(0, 120));
    return '';
  }
}

const arg = (name, dflt = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const isTest = process.argv.includes('--test');
const bodyFile = arg('body-file');
let body = arg('body');
if (bodyFile && fs.existsSync(bodyFile)) body = fs.readFileSync(bodyFile, 'utf8').trim();
let subject = arg('subject', isTest ? '【测试】她掉线通知通道' : '她这边出事了');
if (isTest && !arg('body') && !bodyFile) {
  body = `这是一封测试邮件。\n\n如果你能收到，说明「她掉线时给你发邮件」这条通道是通的。\n\n时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
}
if (!body) {
  console.error('没有正文：用 --body= 或 --body-file= 指定');
  process.exit(2);
}

const auth = readAuth();
if (!auth) {
  log('还没有授权码：先跑 tools/set-mail-auth.cmd（不会的话问 D 老师）');
  process.exit(3);
}

const transport = nodemailer.createTransport({
  host: 'smtp.qq.com',
  port: 465,
  secure: true,
  auth: { user: USER, pass: auth },
});

try {
  const info = await transport.sendMail({
    from: `"大肥鱼掉线提醒" <${USER}>`,
    to: TO,
    subject,
    text: body,
  });
  log(`已发邮件 → ${TO}（${info.messageId || 'ok'}）`);
  process.exit(0);
} catch (e) {
  log('发邮件失败：' + String(e.message || e).slice(0, 200));
  process.exit(4);
}
