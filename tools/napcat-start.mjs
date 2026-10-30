#!/usr/bin/env node
/**
 * napcat-start —— 启动 NapCat 的唯一入口（带锁，防止两个实例抢号）。
 *
 * 2026-10-30 的坑：巡检每 2 分钟拉起一次，我又手动拉起一次，两个 NapCat 抢同一个号：
 * 互相踢、会话被注销、最后全死 —— 表现成「二维码扫了没反应」「扫一次失效一次」。
 *
 * 规则：
 *   1. 3000 已通 → 退出
 *   2. QQ.exe 已经在跑 → 退出（可能正在登录，再起一个就是互相踢）
 *   3. 启动锁：同一时刻只允许一个启动流程
 *   4. 拿到锁后隔 2 秒再确认一次，避免卡在别人启动的空隙里
 *
 * 用法：node tools/napcat-start.mjs [--as-user]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, STATE, stamp, portOpen } from '../lib/base.mjs';
import { singleInstance } from '../lock/single.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOT_BAT = path.join(ROOT, 'napcat-boot.bat');
const LOG = path.join(STATE, 'napcat-start.log');
const AS_USER = process.argv.includes('--as-user');
const DIRECT = process.argv.includes('--direct');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

function runHidden(exe, args) {
  return execFileSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
}

/** QQ 是否已经在跑：有进程就不能再起一个，两个会互相踢 */
function qqRunning() {
  try {
    return /"QQ\.exe"/i.test(runHidden('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/FO', 'CSV', '/NH']));
  } catch { return false; }
}

async function main() {
  if (await portOpen(3000)) { console.log('已经在跑（3000 通），不重复启动'); return; }
  if (qqRunning()) { console.log('QQ 进程已经在跑（可能正在登录），不重复启动'); return; }

  singleInstance('napcat-start');
  await sleep(2000);
  if ((await portOpen(3000)) || qqRunning()) { console.log('另一路已经把它拉起来了，本进程退出'); return; }

  if (DIRECT) {
    // 由 napcat-boot.bat 调进来：这里只做检查 + 拿锁，然后直接调 launcher.bat
    const uin = (process.env.NAPCAT_UIN || '2234510687').trim();
    const dir = path.join(ROOT, 'napcat', 'napcat');
    log('直接启动 launcher.bat -q ' + uin);
    try {
      const child = spawn('cmd.exe', ['/c', `launcher.bat -q ${uin}`], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } catch (e) { log('启动 launcher 失败：' + String(e.message || e)); process.exitCode = 1; }
    return;
  }
  log(AS_USER ? '启动 NapCat（以登录用户权限）' : '启动 NapCat');
  if (!fs.existsSync(BOOT_BAT)) { log('找不到 ' + BOOT_BAT); process.exitCode = 1; return; }
  try {
    if (AS_USER) {
      const child = spawn('explorer.exe', [BOOT_BAT], { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      const child = spawn('cmd.exe', ['/c', `"${BOOT_BAT}"`], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    }
    log('已发出启动请求（真正的登录在 QQ 客户端里进行）');
  } catch (e) {
    log('启动失败：' + String(e.message || e));
    process.exitCode = 1;
  }
}

await main();
