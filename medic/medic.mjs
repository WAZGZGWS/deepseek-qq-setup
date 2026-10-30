#!/usr/bin/env node
/**
 * medic —— 脱离主脑独立运行的急救员。主脑挂了，它负责把主脑救回来。
 *
 * 为什么必须独立：主脑自己就是被守护的对象，它崩了、卡了、被杀了，主脑里写得再好的自愈逻辑
 * 也没人执行。所以这一层不 import 主脑的任何东西，只认两样东西：
 *   · brain.lock 里的 pid 还活着吗
 *   · brain.json（主脑每 20 秒刷新）还新鲜吗
 * 两样都不成立 = 主脑不在，救。
 *
 * 主脑在线时它保持安静：只做「不会和任何脑冲突」的小毛病——
 * 清掉指向死进程的锁文件、自己的日志别涨爆。不碰 worker、不碰 QQ、不动端口。
 *
 * 升级路径（都救不回来时）：
 *   1. 直接拉 brain.mjs
 *   2. 清掉指向死进程的锁，再拉
 *   3. 杀掉卡死的主脑（/T），再拉
 *   4. 写 ALERT-主脑.txt + 发一封邮件（每小时最多一封），等你来看
 *
 * 用法：node medic/medic.mjs        （开机由启动文件夹 / QQBotMedic 计划任务拉起）
 *       node medic/medic.mjs --status
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { ROOT, STATE, stamp, portOpen } from '../lib/base.mjs';

const MEDIC_LOCK = path.join(STATE, 'medic.lock');
const MEDIC_STATE = path.join(STATE, 'medic.json');
const MEDIC_LOG = path.join(STATE, 'medic.log');
const BRAIN_LOCK = path.join(STATE, 'brain.lock');
const BRAIN_JSON = path.join(STATE, 'brain.json');
const CHECK_MS = 10000;
const BRAIN_STALE_MS = 150000;      // 主脑 20 秒一次心跳，超过 2.5 分钟就算卡死
const BOOT_WAIT_MS = 20000;
const MAX_TRIES = 3;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

const STATUS_ONLY = process.argv.includes('--status');

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  try { console.log(line); } catch {}
  try { fs.appendFileSync(MEDIC_LOG, line + '\n'); } catch {}
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }
function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 }); return true; } catch { return false; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function brainPid() {
  try { return Number(fs.readFileSync(BRAIN_LOCK, 'utf8').trim()) || 0; } catch { return 0; }
}

/** 主脑现在什么状态：alive（活且心跳新鲜）/ frozen（活着但不心跳）/ dead */
function brainState(now = Date.now()) {
  const pid = brainPid();
  const alive = pidAlive(pid);
  const jsonAt = Date.parse((readJson(BRAIN_JSON) || {}).at || '') || 0;
  const lockAge = mtime(BRAIN_LOCK) ? now - mtime(BRAIN_LOCK) : -1;
  const jsonAge = jsonAt ? now - jsonAt : -1;
  if (!alive) return { status: 'dead', pid, lockAge, jsonAge };
  const fresh = (lockAge >= 0 && lockAge < BRAIN_STALE_MS) || (jsonAge >= 0 && jsonAge < BRAIN_STALE_MS);
  return { status: fresh ? 'alive' : 'frozen', pid, lockAge, jsonAge };
}

/** 清掉「指向死进程」的锁 —— 唯一允许在主脑在线时做的小动作 */
function quietFixes(now) {
  let cleaned = 0;
  let files = [];
  try { files = fs.readdirSync(STATE).filter((f) => f.endsWith('.lock')); } catch {}
  for (const f of files) {
    if (f === 'medic.lock') continue;
    const p = path.join(STATE, f);
    let pid = 0;
    try { pid = Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch { continue; }
    if (pid && pidAlive(pid)) continue;
    if (now - mtime(p) < 5 * 60 * 1000) continue; // 刚写的先不动，可能是正在启动
    try { fs.unlinkSync(p); cleaned += 1; } catch {}
  }
  // 自己的日志别涨爆
  try {
    if (fs.statSync(MEDIC_LOG).size > 4 * 1024 * 1024) {
      fs.writeFileSync(MEDIC_LOG, fs.readFileSync(MEDIC_LOG, 'utf8').split('\n').slice(-800).join('\n'));
    }
  } catch {}
  return cleaned;
}

function spawnBrain(reason) {
  try {
    const out = fs.openSync(path.join(STATE, 'brain-boot.log'), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'brain.mjs')], {
      cwd: ROOT, stdio: ['ignore', out, out], windowsHide: true, detached: true,
    });
    child.unref();
    try { fs.closeSync(out); } catch {}
    log(`抢救：拉起主脑 pid=${child.pid}（${reason}）`);
    return child.pid;
  } catch (e) {
    log('抢救：拉起主脑失败 ' + e.message);
    return 0;
  }
}

function mailOnce(text) {
  const st = readJson(MEDIC_STATE) || {};
  const now = Date.now();
  if (now - (st.lastMailAt || 0) < ALERT_COOLDOWN_MS) return;
  st.lastMailAt = now;
  writeState(st);
  try {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'notify-offline.mjs'),
      '--subject=主脑挂了，急救员也没救回来', `--body=${text}`], {
      cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: true,
    });
    child.unref();
    log('抢救失败：已发邮件通知');
  } catch (e) { log('抢救失败：邮件也发不出去 ' + e.message); }
}

function writeState(st) {
  try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(MEDIC_STATE, JSON.stringify(st, null, 2)); } catch {}
}

function printStatus() {
  const s = brainState();
  const st = readJson(MEDIC_STATE) || {};
  console.log(`主脑：${s.status}${s.pid ? ` (pid ${s.pid})` : ''}  锁 ${s.lockAge < 0 ? '无' : Math.round(s.lockAge / 1000) + 's'}  状态文件 ${s.jsonAge < 0 ? '无' : Math.round(s.jsonAge / 1000) + 's'}`);
  console.log(`急救员：${pidAlive(Number(fs.readFileSync(MEDIC_LOCK, 'utf8').trim() || 0)) ? '在跑' : '没在跑'}  最近抢救 ${st.lastRescueAt ? new Date(st.lastRescueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '一次都没'}`);
  console.log(`累计抢救 ${st.rescues || 0} 次，连续失败 ${st.fails || 0} 次`);
}

async function rescueLoop() {
  if (STATUS_ONLY) { printStatus(); return; }

  // 单实例：主脑可以有两个在抢锁自己退出，但急救员两个会互相抢着救
  try {
    const old = Number(fs.readFileSync(MEDIC_LOCK, 'utf8').trim()) || 0;
    if (old && old !== process.pid && pidAlive(old)) { console.log(`medic 已在跑 pid ${old}`); process.exit(3); }
  } catch {}
  try { fs.writeFileSync(MEDIC_LOCK, String(process.pid)); } catch {}
  const beat = setInterval(() => { try { fs.writeFileSync(MEDIC_LOCK, String(process.pid)); } catch {} }, 20000);
  beat.unref?.();
  process.on('exit', () => { try { if (Number(fs.readFileSync(MEDIC_LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(MEDIC_LOCK); } catch {} });

  log('急救员上岗（主脑在线时保持安静）');
  const st = readJson(MEDIC_STATE) || {};
  writeState(st);

  let tries = 0;
  let lastProblemAt = 0;

  const tick = async () => {
    const now = Date.now();
    const s = brainState(now);

    if (s.status === 'alive') {
      if (tries > 0) log('主脑回来了');
      tries = 0;
      if (st.fails) { st.fails = 0; writeState(st); }
      quietFixes(now);
      return;
    }

    // 不在（死了或卡死）：开始救
    if (now - lastProblemAt > 5 * 60 * 1000) { tries = 0; lastProblemAt = now; }
    tries += 1;
    st.rescues = (st.rescues || 0) + 1;
    st.lastRescueAt = now;
    writeState(st);

    if (s.status === 'frozen') {
      log(`主脑卡住了（pid ${s.pid}，${Math.round(s.jsonAge / 1000)}s 没心跳），先杀掉再拉`);
      killTree(s.pid);
      await sleep(2000);
    }

    if (tries === 1) {
      spawnBrain(s.status === 'frozen' ? '卡死后重启' : '主脑不在');
    } else if (tries === 2) {
      const cleaned = quietFixes(now);
      log(`第二次救：先清了 ${cleaned} 个死锁，再拉`);
      spawnBrain('第二次');
    } else if (tries >= MAX_TRIES) {
      log(`第 ${tries} 次还是不行，进入硬清场：杀掉所有占着 worker 锁的进程`);
      let files = [];
      try { files = fs.readdirSync(STATE).filter((f) => f.endsWith('.lock')); } catch {}
      for (const f of files) {
        if (f === 'medic.lock') continue;
        const pid = Number((() => { try { return fs.readFileSync(path.join(STATE, f), 'utf8').trim(); } catch { return 0; } })()) || 0;
        if (pid && pidAlive(pid)) killTree(pid);
        try { fs.unlinkSync(path.join(STATE, f)); } catch {}
      }
      spawnBrain('硬清场后');
      st.fails = (st.fails || 0) + 1;
      writeState(st);
      if (tries >= MAX_TRIES + 2) {
        try {
          fs.writeFileSync(path.join(STATE, 'ALERT-主脑.txt'),
            `[${stamp()}] 主脑反复救不回来（连续 ${tries} 次）。\n` +
            `端口：NapCat ${await portOpen(3000).catch(() => false) ? '通' : '断'}，桥接 ${await portOpen(3100).catch(() => false) ? '通' : '断'}\n` +
            `看 ${MEDIC_LOG}\n`);
        } catch {}
        mailOnce(`主脑连续 ${tries} 次没救回来。\n先看 E:\\1\\qq-stack\\state\\medic.log 和 brain.log。\n（主脑在线时这条不会发，只有真救不回来才发）`);
        tries = 0;
      }
    }

    // 给新起的进程 20 秒，然后下一轮检查（不在这里阻塞太久）
    await sleep(BOOT_WAIT_MS);
  };

  // 启动先看一眼，然后 10 秒一轮
  await tick();
  setInterval(() => { void tick().catch((e) => log('急救出错：' + e.message)); }, CHECK_MS);
}

rescueLoop();
