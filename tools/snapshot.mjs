#!/usr/bin/env node
/**
 * snapshot —— 存档点：改坏了能退回去。
 *
 * 今天改了主脑、加了七个器官，全靠手工记得「改之前是什么样」。这里每天自动打一个快照：
 * 关键脚本 + 配置 + 记忆 + 调度表，装进 versions/snapshots/<时间>/，只留最近 7 个。
 *
 * 只做「复制 + 清单」，不压缩、不加密（都在自己机器上）；恢复是**先备份现状态再覆盖**，
 * 所以点错了也能再退回来。
 *
 * 用法：
 *   node tools/snapshot.mjs --auto          一天最多一次（主脑每天调）
 *   node tools/snapshot.mjs --now           立刻打一个
 *   node tools/snapshot.mjs --list          看有哪些
 *   node tools/snapshot.mjs --restore <名>   退回某个快照
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE, stamp } from '../lib/base.mjs';

const NAME = 'snapshot';
const LOCK = path.join(STATE, `${NAME}.lock`);
const SNAP_DIR = path.join(ROOT, 'versions', 'snapshots');
const KEEP = 7;
const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');

const ARGS = process.argv.slice(2);
const AUTO = ARGS.includes('--auto');
const NOW = ARGS.includes('--now');
const LIST = ARGS.includes('--list');
const RESTORE = (() => { const i = ARGS.indexOf('--restore'); return i >= 0 ? ARGS[i + 1] : ''; })();

// 要存档的东西：脚本 + 配置 + 记忆 + 调度
const FILES = [
  'brain.mjs',
  'hemis/left.mjs', 'hemis/right.mjs', 'hemis/cerebellum.mjs',
  'hands/left-hand.mjs', 'hands/right-hand.mjs',
  'logic/organs.mjs',
  'eye/eye.mjs', 'mouth/mouth.mjs', 'medic/medic.mjs',
  'blackbox/blackbox.mjs', 'vitals/vitals.mjs', 'treasurer/treasurer.mjs',
  'hippocampus/hippocampus.mjs', 'ears/ears.mjs', 'world/world.mjs', 'mirror/mirror.mjs',
  'tools/qr-screen.mjs', 'tools/qr-black.ps1', 'tools/qr-live.mjs', 'tools/snapshot.mjs',
  'supervisor/workers.mjs', 'regression/regression.mjs',
  'state/scheduler.json', 'state/special-days.json', 'state/cerebellum.json', 'state/joy.json',
  'chat-memory/live.json',
];
const DIRS = ['roles'];

function readPid(p) { try { return Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch { return 0; } }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function copyFile(src, dst) {
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch { return false; }
}
function copyDir(src, dst) {
  try {
    fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(src)) {
      const s = path.join(src, n);
      const d = path.join(dst, n);
      if (fs.statSync(s).isDirectory()) copyDir(s, d);
      else copyFile(s, d);
    }
    return true;
  } catch { return false; }
}

function latest() {
  try {
    const list = fs.readdirSync(SNAP_DIR).filter((n) => fs.statSync(path.join(SNAP_DIR, n)).isDirectory()).sort();
    return list.length ? list[list.length - 1] : '';
  } catch { return ''; }
}

function makeSnapshot(why = '') {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(SNAP_DIR, ts);
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const rel of FILES) {
    const src = path.join(ROOT, rel.replace(/\//g, path.sep));
    if (!fs.existsSync(src)) continue;
    if (copyFile(src, path.join(dir, rel))) n += 1;
  }
  for (const d of DIRS) {
    const src = path.join(ROOT, d);
    if (fs.existsSync(src) && copyDir(src, path.join(dir, d))) n += 1;
  }
  // 配置单独放：里面有账号信息，只留在本机快照里
  const cfg = path.join(BRIDGE, 'config.json');
  if (fs.existsSync(cfg) && copyFile(cfg, path.join(dir, 'bridge-config.json'))) n += 1;

  fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify({ at: new Date().toISOString(), why, files: n }, null, 2));

  // 只留最近 KEEP 个
  try {
    const all = fs.readdirSync(SNAP_DIR).filter((x) => fs.statSync(path.join(SNAP_DIR, x)).isDirectory()).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
      fs.rmSync(path.join(SNAP_DIR, old), { recursive: true, force: true });
    }
  } catch {}
  console.log(`[${stamp()}] 存档点：${ts}（${n} 项）${why ? ' — ' + why : ''}`);
  return ts;
}

function listSnapshots() {
  let list = [];
  try { list = fs.readdirSync(SNAP_DIR).filter((n) => fs.statSync(path.join(SNAP_DIR, n)).isDirectory()).sort(); } catch {}
  if (!list.length) { console.log('还没有存档点'); return; }
  for (const n of list) {
    const man = (() => { try { return JSON.parse(fs.readFileSync(path.join(SNAP_DIR, n, 'MANIFEST.json'), 'utf8')); } catch { return null; } })();
    console.log(`${n}  ${man ? man.files + ' 项 ' + (man.why || '') : ''}`);
  }
}

function restore(name) {
  const dir = path.join(SNAP_DIR, name);
  if (!fs.existsSync(dir)) { console.log('没有这个存档点：' + name); return 1; }
  // 先把当前状态也存一份，点错了还能退回来
  makeSnapshot('回滚前自动备份（要退回到 ' + name + '）');
  let n = 0;
  const walk = (base, rel) => {
    for (const item of fs.readdirSync(path.join(base, rel))) {
      const relPath = path.join(rel, item);
      const abs = path.join(base, relPath);
      if (fs.statSync(abs).isDirectory()) { walk(base, relPath); continue; }
      if (relPath === 'MANIFEST.json') continue;
      const target = relPath === 'bridge-config.json' ? path.join(BRIDGE, 'config.json') : path.join(ROOT, relPath);
      if (copyFile(abs, target)) n += 1;
    }
  };
  walk(dir, '');
  console.log(`[${stamp()}] 已回滚 ${name}（覆盖 ${n} 个文件；回滚前的状态也存了一份）`);
  console.log('提示：主脑/器官要重启才会用上新代码（node brain.mjs 会自动被急救员拉起）。');
  return 0;
}

function main() {
  if (LIST) { listSnapshots(); return; }
  if (RESTORE) { process.exit(restore(RESTORE)); }
  const old = readPid(path.join(STATE, `${NAME}.lock`));
  if (old && old !== process.pid && pidAlive(old)) { console.log('存档点正在跑'); return; }
  fs.writeFileSync(path.join(STATE, `${NAME}.lock`), String(process.pid));
  try {
    if (AUTO) {
      const last = latest();
      if (last && Date.now() - fs.statSync(path.join(SNAP_DIR, last)).mtimeMs < 20 * 3600 * 1000) {
        console.log('今天已经存过了');
        return;
      }
      makeSnapshot('每日自动');
    } else {
      makeSnapshot(NOW ? '手动 --now' : '手动');
    }
  } finally {
    try { fs.unlinkSync(path.join(STATE, `${NAME}.lock`)); } catch {}
  }
}

main();
