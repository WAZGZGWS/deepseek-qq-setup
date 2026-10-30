#!/usr/bin/env node
/**
 * eye —— 眼：只观察、只上报，永远不动手。
 *
 * 为什么要单独一只眼：主脑会看自己（status/决策），急救员只看主脑死活。三脑内部的小毛病
 * （某个脑自己下线了、worker 锁僵住了、状态文件写坏了、端口掉了）没人专门盯。
 * 眼就是干这个的：静默跑，发现问题就写进 state/eye-findings.json 交给急救员，
 * 自己不修、不重启、不删任何东西 —— 观察和执行分开，才不会「看错的自己动手修」。
 *
 * 眼不 import 主脑、也不 import 急救员：它只看文件/端口/进程，谁也不依赖。
 *
 * 用法：node eye/eye.mjs           前台跑（开机由 QQBotEye 任务拉起）
 *       node eye/eye.mjs --status  看它最近看到了什么
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { ROOT, STATE, stamp, portOpen } from '../lib/base.mjs';

const EYE_LOCK = path.join(STATE, 'eye.lock');
const EYE_STATE = path.join(STATE, 'eye.json');
const EYE_FINDINGS = path.join(STATE, 'eye-findings.json');
const EYE_LOG = path.join(STATE, 'eye.log');
const CHECK_MS = 15000;
const STATUS_ONLY = process.argv.includes('--status');

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  try { fs.appendFileSync(EYE_LOG, line + '\n'); } catch {}
  try { console.log(line); } catch {}
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function rawText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function procCount(image) {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    return (out.match(new RegExp(image.replace('.', '\\.'), 'gi')) || []).length;
  } catch { return -1; }
}

// ── 观察规则。每条 finding 带 code，急救员按 code 找解决办法 ──────────
async function observe() {
  const now = Date.now();
  const findings = [];
  const add = (code, severity, what, extra = {}) => findings.push({ code, severity, what, at: new Date(now).toISOString(), ...extra });

  // 1. 主脑：死活/卡死
  const brainPid = Number((rawText(path.join(STATE, 'brain.lock')) || '').trim()) || 0;
  const bj = readJson(path.join(STATE, 'brain.json'));
  const brainAge = bj && bj.at ? now - Date.parse(bj.at) : -1;
  if (!brainPid || !pidAlive(brainPid)) add('brain-dead', 'critical', '主脑进程不在');
  else if (brainAge > 150000) add('brain-frozen', 'critical', `主脑 ${Math.round(brainAge / 1000)} 秒没刷新状态`, { brainAge });

  // 2. 急救员
  const medicPid = Number((rawText(path.join(STATE, 'medic.lock')) || '').trim()) || 0;
  if (!medicPid || !pidAlive(medicPid)) {
    add('medic-dead', 'critical', '急救员没在跑（上报没人接）');
    // 眼唯一的例外：上报通道本身断了，把急救员叫起来。除此之外眼不动任何东西。
    try {
      if (fs.existsSync(path.join(ROOT, 'medic', 'medic.mjs'))) {
        const c = spawn(process.execPath, [path.join(ROOT, 'medic', 'medic.mjs')], {
          cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: true,
        });
        c.unref();
        log(`上报通道断了，先把急救员叫起来 pid=${c.pid}`);
      }
    } catch {}
  }

  // 3. 三脑
  const h = bj && bj.hemis;
  if (h) {
    for (const name of ['left', 'right', 'cerebellum']) {
      const s = h[name];
      if (!s) continue;
      if (s.status === 'offline') add('hemi-offline', 'warn', `${name} 自己下线了`, { hemi: name, offlineSec: s.offlineSec || 0 });
    }
    if (h.left && h.left.errors > 0) add('hemi-left-errors', 'warn', `左脑连续异常 ${h.left.errors} 次`, { errors: h.left.errors });
  }

  // 4. worker：停了 / 锁僵住
  if (bj && Array.isArray(bj.workers)) {
    for (const w of bj.workers) {
      if (!w.alive && !w.quarantineSec && !w.broken) add('worker-down', 'warn', `${w.name} 没在跑`, { worker: w.name });
      else if (w.alive && w.lockAgeSec > 180) add('worker-lock-stale', 'warn', `${w.name} 活着但锁 ${w.lockAgeSec}s 没跳`, { worker: w.name, lockAge: w.lockAgeSec });
    }
  }

  // 5. 端口
  const napcat = await portOpen(3000).catch(() => false);
  const bridge = await portOpen(3100).catch(() => false);
  if (!napcat) add('port-napcat-down', 'warn', ':3000 断了');
  if (!bridge) add('port-bridge-down', 'warn', ':3100 断了');

  // 6. 状态文件写坏（主脑启动时读到坏 JSON 会直接起不来）
  for (const name of ['right-brain.json', 'cerebellum.json', 'brain.json', 'medic.json', 'social-v2.json']) {
    const p = name === 'social-v2.json'
      ? path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'state', name)
      : path.join(STATE, name);
    const raw = rawText(p);
    if (raw === null) continue;
    if (!readJson(p)) add('state-corrupt', 'critical', `${name} 不是合法 JSON`, { file: p });
  }

  // 7. 日志涨爆 / 主脑日志里出现未捕获异常
  for (const f of ['brain.log', 'medic.log', 'eye.log']) {
    const p = path.join(STATE, f);
    try {
      const sz = fs.statSync(p).size;
      if (sz > 8 * 1024 * 1024) add('log-big', 'info', `${f} 已 ${Math.round(sz / 1048576)}MB`, { file: p });
    } catch {}
  }
  const brainLog = rawText(path.join(STATE, 'brain.log')) || '';
  if (/未捕获异常|unhandledRejection/.test(brainLog.split('\n').slice(-200).join('\n'))) {
    add('brain-log-error', 'warn', '主脑日志里出现未捕获异常');
  }

  // 8. 磁盘 / QQ 进程数
  try {
    if (fs.statfsSync) {
      const st = fs.statfsSync(ROOT);
      const freeGb = (st.bavail * st.bsize) / 1024 / 1024 / 1024;
      if (freeGb < 2) add('disk-low', 'warn', `磁盘只剩 ${freeGb.toFixed(1)}GB`, { freeGb });
    }
  } catch {}
  const qq = procCount('QQ.exe');
  if (qq > 8) add('qq-processes-many', 'warn', `QQ 进程 ${qq} 个（单实例正常 4~5）`, { qq });

  // 9. 记忆/余额这类「慢问题」：只报不修
  const bw = readJson(path.join(ROOT, 'state', 'balance-watch.json'));
  if (bw && Number(bw.lastBalance) > 0 && Number(bw.lastBalance) < 1) add('balance-critical', 'warn', `余额 ${bw.lastBalance} 元`);

  return { findings, ports: { napcat, bridge }, brainPid, medicPid, brainAge };
}

function printStatus() {
  const s = readJson(EYE_STATE);
  if (!s) { console.log('眼还没跑过（没有 state/eye.json）'); return; }
  console.log(`眼 pid=${s.pid}  更新于 ${new Date(s.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log(`  看到：主脑 ${s.brainPid || '无'}，急救员 ${s.medicPid || '无'}，端口 NapCat ${s.ports?.napcat ? '通' : '断'} / 桥接 ${s.ports?.bridge ? '通' : '断'}`);
  const f = readJson(EYE_FINDINGS) || { findings: [] };
  if (!f.findings.length) { console.log('  没有发现问题'); return; }
  console.log(`  待处理问题 ${f.findings.length} 条：`);
  for (const x of f.findings.slice(-10)) console.log(`    [${x.severity}] ${x.what}（${x.code}）`);
}

async function main() {
  if (STATUS_ONLY) { printStatus(); return; }
  try {
    const old = Number((rawText(EYE_LOCK) || '').trim()) || 0;
    if (old && old !== process.pid && pidAlive(old)) { console.log('眼已有实例在跑'); process.exit(3); }
  } catch {}
  try { fs.writeFileSync(EYE_LOCK, String(process.pid)); } catch {}
  const beat = setInterval(() => { try { fs.writeFileSync(EYE_LOCK, String(process.pid)); } catch {} }, 20000);
  beat.unref?.();
  process.on('exit', () => { try { if (Number((rawText(EYE_LOCK) || '').trim()) === process.pid) fs.unlinkSync(EYE_LOCK); } catch {} });

  log('眼上岗（静默观察，只上报不动手）');
  let lastSignature = '';

  const tick = async () => {
    try {
      const r = await observe();
      const sig = r.findings.map((f) => f.code + (f.worker || f.hemi || '')).sort().join('|');
      const state = {
        at: new Date().toISOString(),
        pid: process.pid,
        brainPid: r.brainPid,
        medicPid: r.medicPid,
        brainAge: r.brainAge,
        ports: r.ports,
        findings: r.findings,
      };
      try {
        fs.mkdirSync(STATE, { recursive: true });
        fs.writeFileSync(EYE_STATE, JSON.stringify(state, null, 2));
        fs.writeFileSync(EYE_FINDINGS, JSON.stringify({ at: state.at, findings: r.findings }, null, 2));
      } catch {}
      if (sig !== lastSignature) {
        lastSignature = sig;
        if (!r.findings.length) log('检查：一切正常');
        else log(`上报 ${r.findings.length} 条：` + r.findings.map((f) => f.code).join(', '));
      }
    } catch (e) {
      log('观察出错：' + e.message);
    }
  };

  await tick();
  setInterval(() => { void tick(); }, CHECK_MS);
}

await main();
