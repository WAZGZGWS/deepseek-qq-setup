#!/usr/bin/env node
/**
 * ears —— 耳朵：把他回的邮件变成指令（现在邮件只有发、没有收）。
 *
 * 场景：你上班不在电脑前，她掉线 → 她发邮件给你 → 你回一句「重启」。
 * 以前这句没人听；耳朵每 5 分钟收一次信，只认**你自己**发来的、只在白名单里的命令，
 * 执行完把邮件标已读，最多回一封确认信（每天最多 6 封，不刷屏）。
 *
 * 白名单（subject 里出现这些词之一）：
 *   状态 → 回一封现状（主脑/端口/worker/余额）
 *   重启 → 主脑不在就拉起来
 *   扫码 → 拉起扫码黑屏
 *   省钱 → 关掉主动发言（写 cerebellum-policy）
 *
 * 凭据沿用掉线通知那套：config.json 的 notify.mail + qq-mail-auth.dat（DPAPI）。
 *
 * 用法：node ears/ears.mjs  |  --status  |  --once
 */
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { spawn, execFileSync } from 'node:child_process';
import { ROOT, STATE, stamp } from '../lib/base.mjs';

const NAME = 'ears';
const LOCK = path.join(STATE, `${NAME}.lock`);
const FILE = path.join(STATE, 'ears.json');
const LOG = path.join(STATE, 'ears.log');
const TICK_MS = 5 * 60 * 1000;
const IMAP = { host: 'imap.qq.com', port: 993 };
const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');

const STATUS_ONLY = process.argv.includes('--status');
const ONCE = process.argv.includes('--once');
const SELFTEST = process.argv.includes('--selftest');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function readPid(p) { try { return Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch { return 0; } }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function log(msg) { const line = `[${stamp()}] ${msg}`; try { fs.appendFileSync(LOG, line + '\n'); } catch {} console.log(line); }

function mailCfg() {
  const out = { user: process.env.QQ_MAIL_USER || '', host: 'imap.qq.com', port: 993 };
  try {
    const cfgPath = [path.join(BRIDGE, 'config.json'), path.join(ROOT, 'config.json')].find((f) => fs.existsSync(f));
    const cfg = cfgPath ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
    const mail = cfg?.notify?.mail || {};
    out.user = out.user || String(mail.user || '');
  } catch {}
  return out;
}

/** 授权码：DPAPI（跟 notify-offline 同一套，不落明文） */
function readAuth() {
  if (process.env.QQ_MAIL_AUTH) return process.env.QQ_MAIL_AUTH.trim();
  const f = path.join(ROOT, 'qq-mail-auth.dat');
  if (!fs.existsSync(f)) return '';
  try {
    const b64 = fs.readFileSync(f, 'utf8').trim();
    const ps = [
      'Add-Type -AssemblyName System.Security',
      `$b=[Convert]::FromBase64String('${b64}')`,
      '$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      '[Text.Encoding]::UTF8.GetString($p)',
    ].join('; ');
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
  } catch { return ''; }
}

/** 极简 IMAP：只用到 LOGIN / SELECT / SEARCH / FETCH / STORE / LOGOUT */
class Imap {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); this.tag = 0; }
  static connect() {
    return new Promise((resolve, reject) => {
      const s = tls.connect({ host: IMAP.host, port: IMAP.port, servername: IMAP.host }, () => resolve(new Imap(s)));
      s.setTimeout(20000, () => { try { s.destroy(); } catch {} reject(new Error('IMAP 连接超时')); });
      s.once('error', (e) => reject(e));
    });
  }
  read() {
    return new Promise((resolve) => {
      const onData = (d) => { this.buf = Buffer.concat([this.buf, d]); this.sock.off('data', onData); resolve(); };
      this.sock.on('data', onData);
    });
  }
  async cmd(text) {
    this.tag += 1;
    const tag = `a${this.tag}`;
    this.buf = Buffer.alloc(0);
    this.sock.write(`${tag} ${text}\r\n`);
    const deadline = Date.now() + 25000;
    for (;;) {
      if (this.buf.includes(`${tag} OK`) || this.buf.includes(`${tag} NO`) || this.buf.includes(`${tag} BAD`)) break;
      if (Date.now() > deadline) throw new Error('IMAP 命令超时: ' + text.slice(0, 30));
      await this.read();
    }
    const textOut = this.buf.toString('utf8');
    return { text: textOut, buf: this.buf };
  }
  quit() { try { this.sock.write('z LOGOUT\r\n'); this.sock.end(); } catch {} }
}

/** =?UTF-8?B?...?= 这类编码的标题要解出来才看得懂命令 */
function decodeMime(s) {
  return String(s || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc, data) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString('utf8');
      return decodeURIComponent(data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, '%$1'));
    } catch { return m; }
  });
}

function headerField(text, name) {
  const re = new RegExp(`^${name}:\\s*(.*(?:\\r?\\n[ \\t].*)*)`, 'im');
  const m = text.match(re);
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
}

function mailCountToday(st) {
  const day = new Date().toISOString().slice(0, 10);
  return st.mailDay === day ? Number(st.mailN || 0) : 0;
}

function sendMail(subject, body) {
  try {
    const c = spawn(process.execPath, [path.join(ROOT, 'tools', 'notify-offline.mjs'), `--subject=${subject}`, `--body=${body}`], {
      cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: true,
    });
    c.unref();
    return true;
  } catch { return false; }
}

function doStatus() {
  const bj = readJson(path.join(STATE, 'brain.json')) || {};
  const v = readJson(path.join(STATE, 'vitals.json')) || {};
  const bw = readJson(path.join(ROOT, 'state', 'balance-watch.json')) || {};
  const ws = Array.isArray(bj.workers) ? bj.workers : [];
  return [
    `主脑：${bj.pid ? '在跑 pid ' + bj.pid : '不在'}`,
    `NapCat:${bj.napcat ? '通' : '断'} 桥接:${bj.bridge ? '通' : '断'}`,
    `worker：${ws.filter((w) => w.alive).length}/${ws.length} 在跑`,
    `她能回话吗：${v.stuck ? '卡住（有未读没回）' : '正常'}，未读 ${v.unread ?? '?'}`,
    `余额：${bw.lastBalance ?? '?'} 元`,
  ].join('\n');
}

function runCommand(cmd, dry = false) {
  if (dry) return { ok: true, act: "自测", reply: "（自测：只验证命令能不能被识别，不真的执行）" };
  if (/状态|status/i.test(cmd)) return { ok: true, reply: doStatus(), act: '状态' };
  if (/重启|restart/i.test(cmd)) {
    const pid = readPid(path.join(STATE, 'brain.lock'));
    if (pid && pidAlive(pid)) return { ok: true, reply: `主脑在跑（pid ${pid}），不用重启。`, act: '重启（跳过）' };
    try {
      const c = spawn(process.execPath, [path.join(ROOT, 'brain.mjs')], { cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: true });
      c.unref();
      return { ok: true, reply: '主脑不在，已经拉起来了。', act: '重启' };
    } catch (e) { return { ok: false, reply: '拉起失败：' + e.message, act: '重启' }; }
  }
  if (/扫码|qrcode|qr/i.test(cmd)) {
    try {
      const c = spawn(process.execPath, [path.join(ROOT, 'tools', 'qr-screen.mjs')], { cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: true });
      c.unref();
      return { ok: true, reply: '扫码黑屏拉起来了，屏幕上看二维码。', act: '扫码' };
    } catch (e) { return { ok: false, reply: '拉扫码失败：' + e.message, act: '扫码' }; }
  }
  if (/省钱|省着|save/i.test(cmd)) {
    try {
      fs.writeFileSync(path.join(ROOT, 'state', 'cerebellum-policy.json'), JSON.stringify({ proactive: 'off', why: '耳朵收到「省钱」指令', at: new Date().toISOString() }, null, 2));
      return { ok: true, reply: '好，主动发言关了，省着用。', act: '省钱' };
    } catch (e) { return { ok: false, reply: '写策略失败：' + e.message, act: '省钱' }; }
  }
  return { ok: false, reply: '', act: '' };
}

async function checkOnce() {
  const cfg = mailCfg();
  const auth = readAuth();
  if (!cfg.user || !auth) { log('耳朵没配置（缺 notify.mail 或授权码）'); return; }
  const st = readJson(FILE) || { seen: [], mailDay: '', mailN: 0 };
  st.seen = (st.seen || []).slice(-200);

  let imap;
  try { imap = await Imap.connect(); } catch (e) { log('连 IMAP 失败：' + e.message); return; }
  try {
    await imap.cmd(`LOGIN "${cfg.user}" "${auth.replace(/"/g, '\\"')}"`);
    await imap.cmd('SELECT INBOX');
    const search = await imap.cmd('UID SEARCH UNSEEN');
    const uids = [...search.text.matchAll(/^\* SEARCH ([0-9 ]+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/)).filter(Boolean);
    const todo = uids.slice(-5);
    if (!todo.length) { st.at = new Date().toISOString(); fs.writeFileSync(FILE, JSON.stringify(st, null, 2)); return; }

    for (const uid of todo) {
      const got = await imap.cmd(`UID FETCH ${uid} BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)]`);
      const m = got.buf.toString('utf8').match(/\{(\d+)\}\r?\n/);
      let header = '';
      if (m) {
        const start = got.buf.indexOf(Buffer.from(`{${m[1]}}\r\n`)) + `{${m[1]}}\r\n`.length;
        header = got.buf.slice(start, start + Number(m[1])).toString('utf8');
      }
      if (!header) header = got.text;
      const from = decodeMime(headerField(header, 'From'));
      const subject = decodeMime(headerField(header, 'Subject'));

      // 只认两个来源：你自己的邮箱（可能和机器人同一个），或者配置里 INBOX_OWNER_EMAIL
      const owners = [cfg.user, cfg.to, process.env.INBOX_OWNER_EMAIL].filter(Boolean).map((x) => String(x).toLowerCase());
      if (!owners.some((o) => from.toLowerCase().includes(o))) {
        await imap.cmd(`UID STORE ${uid} +FLAGS (\\Seen)`);
        continue;
      }
      const res = runCommand(subject);
      st.seen.push({ uid, at: new Date().toISOString(), subject, act: res.act || '未识别' });
      st.at = new Date().toISOString();
      fs.writeFileSync(FILE, JSON.stringify(st, null, 2));
      log(`收到指令「${subject}」→ ${res.act || '未识别'}`);

      if (res.act && res.reply) {
        const used = mailCountToday(st);
        if (used < 6) {
          sendMail('耳朵回信：' + res.act, res.reply);
          st.mailDay = new Date().toISOString().slice(0, 10);
          st.mailN = used + 1;
          fs.writeFileSync(FILE, JSON.stringify(st, null, 2));
        }
      }
      await imap.cmd(`UID STORE ${uid} +FLAGS (\\Seen)`);
    }
  } catch (e) {
    log('收信出错：' + e.message);
  } finally {
    imap.quit();
  }
}

function printStatus() {
  const st = readJson(FILE) || {};
  console.log(`耳朵：${st.at ? new Date(st.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '还没收过信'}`);
  console.log(`  今天回信 ${mailCountToday(st)} 封；最近处理：${(st.seen || []).slice(-3).map((x) => x.subject + '→' + x.act).join(' / ') || '无'}`);
}

async function main() {
  if (SELFTEST) {
    const kinds = [['状态', /状态|status/i], ['重启', /重启|restart/i], ['扫码', /扫码|qrcode|qr/i], ['省钱', /省钱|省着|save/i]];
    for (const c of ['状态', '重启', '扫码', '省钱', '随便说点啥']) {
      const hit = kinds.find(([, re]) => re.test(c));
      console.log(`指令「${c}」→ ${hit ? hit[0] : '未识别'}`);
    }
    return;
  }
  if (STATUS_ONLY) { printStatus(); return; }
  const old = readPid(LOCK);
  if (old && old !== process.pid && pidAlive(old)) { console.log('耳朵已有实例在跑'); process.exit(3); }
  fs.writeFileSync(LOCK, String(process.pid));
  const beat = setInterval(() => { try { fs.writeFileSync(LOCK, String(process.pid)); } catch {} }, 20000);
  beat.unref?.();
  process.on('exit', () => { try { if (readPid(LOCK) === process.pid) fs.unlinkSync(LOCK); } catch {} });

  if (ONCE) { await checkOnce(); return; }
  for (;;) {
    await checkOnce();
    await sleep(TICK_MS);
  }
}

main();
