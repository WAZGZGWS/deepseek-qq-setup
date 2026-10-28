#!/usr/bin/env node
/**
 * daily-check —— 每天检查本地补丁是否还在（桥接升级会覆盖）
 * 由 cron 03:30 调用；发现补丁丢失就通过 notify 发外部告警。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { notify } from '../notify/notify.mjs';
import { STATE, stamp, dirOf } from '../lib/base.mjs';

const HERE = dirOf(import.meta.url);

function log(...a) {
  const line = `[${stamp()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(STATE, 'daily-check.log'), line + '\n'); } catch {}
}

let out = '';
try {
  out = execFileSync(process.execPath, [path.join(HERE, 'repatch.mjs'), '--check'], { encoding: 'utf8', windowsHide: true });
} catch (e) {
  out = String(e.stdout || e.message);
}

const missing = (out.match(/已补/g) || []).length;
if (missing > 0) {
  log('本地补丁缺失:', out.trim().replace(/\n/g, ' | '));
  await notify(`[QQ Bot] 检测到桥接补丁被覆盖（${missing} 处），请运行 patches/repatch.mjs 修复`);
  process.exit(2);
}
log('补丁完整');
