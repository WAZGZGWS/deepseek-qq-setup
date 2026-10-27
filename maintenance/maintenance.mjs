#!/usr/bin/env node
/**
 * maintenance —— 日志轮转 + 配置备份
 *
 * 1) state/*.log 超过 5MB 就改名成 .1 / .2 ...，最多留 5 份
 * 2) 把角色卡、config、scheduler、social-v2（记忆）复制到 backups/YYYY-MM-DD/
 *    目录太大就只留最近 7 份
 */
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');
const STATE = path.join(BRIDGE, 'state');
const BACKUPS = path.join(ROOT, 'backups');


// 7z 加密打包（密码存在 state/backup-pass.txt，首次自动生成）
const SEVEN_ZIP = process.env.SEVEN_ZIP || 'E:\\7-Zip\\7z.exe';
function backupPassword() {
  const f = path.join(STATE, 'backup-pass.txt');
  try {
    const v = fs.readFileSync(f, 'utf8').trim();
    if (v) return v;
  } catch {}
  const pwd = require('node:crypto').randomBytes(12).toString('base64url');
  try { fs.writeFileSync(f, pwd); } catch {}
  return pwd;
}
function makeEncryptedArchive(srcDir, destBase) {
  if (!fs.existsSync(SEVEN_ZIP)) { log('未找到 7z，跳过加密打包'); return null; }
  const out = destBase + '.7z';
  try {
    const pwd = backupPassword();
    execSync(`"${SEVEN_ZIP}" a -t7z "${out}" "${srcDir}\\*" -p"${pwd}" -mhe=on -mx=5`, { stdio: 'ignore', windowsHide: true });
    log('加密备份 ->', out);
    return out;
  } catch (e) {
    log('加密备份失败:', e.message);
    return null;
  }
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_LOGS = 5;
const KEEP_BACKUPS = 7;

function log(...a) {
  console.log(`[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}] ${a.join(' ')}`);
}

function rotate(file, maxBytes = MAX_LOG_BYTES) {
  if (!fs.existsSync(file)) return false;
  const size = fs.statSync(file).size;
  if (size < maxBytes) return false;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(file, `${file}.${stamp}`);
  // 清理旧的分片
  const dir = path.dirname(file);
  const base = path.basename(file);
  const parts = fs.readdirSync(dir).filter((n) => n.startsWith(base + '.')).sort();
  while (parts.length > KEEP_LOGS) {
    const victim = parts.shift();
    try { fs.unlinkSync(path.join(dir, victim)); } catch {}
  }
  log(`轮转 ${base}（${(size / 1048576).toFixed(1)}MB）`);
  return true;
}

function backup() {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const dest = path.join(BACKUPS, day);
  fs.mkdirSync(path.join(dest, 'roles'), { recursive: true });
  const copy = (src, dst) => {
    try { if (fs.existsSync(src)) fs.copyFileSync(src, dst); } catch (e) { log('复制失败', src, e.message); }
  };
  // 角色卡
  const roles = path.join(BRIDGE, 'roles');
  if (fs.existsSync(roles)) {
    for (const f of fs.readdirSync(roles)) copy(path.join(roles, f), path.join(dest, 'roles', f));
  }
  copy(path.join(BRIDGE, 'config.json'), path.join(dest, 'config.json'));
  copy(path.join(STATE, 'scheduler.json'), path.join(dest, 'scheduler.json'));
  copy(path.join(STATE, 'social-v2.json'), path.join(dest, 'social-v2.json'));
  copy(path.join(STATE, 'current-role.json'), path.join(dest, 'current-role.json'));
  log('备份完成 ->', dest);

  // 异地一份：云盘目录会自动同步
  const cloudRoot = process.env.CLOUD_BACKUP_DIR || path.join(os.homedir(), 'OneDrive', 'qq-bot-backup');
  try {
    if (fs.existsSync(path.join(os.homedir(), 'OneDrive'))) {
      const cloudDest = path.join(cloudRoot, day);
      fs.mkdirSync(path.dirname(cloudDest), { recursive: true });
      fs.cpSync(dest, cloudDest, { recursive: true, force: true });
      log('已同步到云盘 ->', cloudDest);
      makeEncryptedArchive(dest, path.join(cloudRoot, day));
      const cdirs = fs.readdirSync(cloudRoot).sort();
      while (cdirs.length > KEEP_BACKUPS) {
        const v = cdirs.shift();
        fs.rmSync(path.join(cloudRoot, v), { recursive: true, force: true });
      }
    }
  } catch (e) { log('云盘备份失败:', e.message); }

  // 只留最近 N 份
  const dirs = fs.readdirSync(BACKUPS).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
  while (dirs.length > KEEP_BACKUPS) {
    const victim = dirs.shift();
    fs.rmSync(path.join(BACKUPS, victim), { recursive: true, force: true });
    log('清理旧备份', victim);
  }
}

for (const name of ['bridge.log', 'janitor.log', 'watchdog.log', 'qq-activity.log']) {
  rotate(path.join(STATE, name));
}
// jsonl 数据文件涨得慢（每天约 100KB），到 20MB 才轮转；留 3 份即可
for (const name of ['token-usage.jsonl', 'tool-calls.jsonl']) {
  rotate(path.join(STATE, name), 20 * 1024 * 1024);
}
backup();
