#!/usr/bin/env node
import { singleInstance } from '../lock/single.mjs';
// 定时任务（计划任务）和 cron 都可能拉起同一个脚本：加实例锁，重复触发时后来的直接退出。
// 2026-10-29 实测：patrol 在 09:00:02 和 09:00:15 各跑了一遍，就是两套调度撞在一起。
singleInstance('maintenance');
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
import { ROOT, BRIDGE, STATE, stamp } from '../lib/base.mjs';

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
  const line = `[${stamp()}] ${a.join(' ')}`;
  // 必须落文件：supervisor 拉起时 stdio 是 ignore，只 console.log 等于什么都没留下，
  // 备份到底成没成功根本查不到（2026-10-28 实际踩到）
  try { console.log(line); } catch {}
  try {
    fs.mkdirSync(STATE, { recursive: true });
    const f = path.join(STATE, 'maintenance.log');
    try { if (fs.statSync(f).size > 512 * 1024) fs.renameSync(f, f + '.1'); } catch {}
    fs.appendFileSync(f, line + '\n');
  } catch {}
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

  // 异地一份：OneDrive 会自动同步到云
  const cloudRoot = process.env.CLOUD_BACKUP_DIR || path.join(os.homedir(), 'OneDrive', 'qq-bot-backup');
  try {
    if (fs.existsSync(path.join(os.homedir(), 'OneDrive'))) {
      // 只把加密包放云上。原来这里会先 cpSync 一份明文目录到 OneDrive，
      // 里面是 config.json（含 consoleToken）、人设和全部记忆 ——
      // 等于把加密包的意义抵消掉了。2026-10-28 改掉。
      fs.mkdirSync(cloudRoot, { recursive: true });
      const arc = makeEncryptedArchive(dest, path.join(cloudRoot, day));
      if (arc) log('已同步加密包到云端 ->', arc);
      else log('加密包没打出来（检查 7z 是否存在），本次没有云端备份');

      // 顺手清掉旧版本留下的明文目录（纯日期命名的那些）。
      // 它们装了 config.json（含 consoleToken）、人设和全部记忆，留在云上等于没加密。
      try {
        for (const name of fs.readdirSync(cloudRoot)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
          const p2 = path.join(cloudRoot, name);
          if (!fs.statSync(p2).isDirectory()) continue;
          fs.rmSync(p2, { recursive: true, force: true });
          log('清掉云上的明文备份目录', name);
        }
      } catch (e) { log('清理明文目录失败（可能被 OneDrive 占用）:', e.message); }
      const cdirs = fs.readdirSync(cloudRoot).sort();
      while (cdirs.length > KEEP_BACKUPS) {
        const v = cdirs.shift();
        fs.rmSync(path.join(cloudRoot, v), { recursive: true, force: true });
      }
    }
  } catch (e) { log('OneDrive 备份失败:', e.message); }

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
/**
 * 清理「跑完就停用」的一次性任务（滴眼药水、生日补发这类）。
 *
 * 它们到点执行完会变成 disabled 留在 scheduler 里，一天两条地攒 ——
 * 攒上两周，列表里几十条停用的，人和 AI 都看不清哪些还在生效。
 * 只删「once 类型 + 已停用 + 日期早于昨天」的，绝不碰 yearly/daily 和还没到点的。
 */
async function pruneFinishedTasks() {
  const base = 'http://127.0.0.1:3100';
  let token = '';
  try { token = fs.readFileSync(path.join(BRIDGE, 'state', 'console-token'), 'utf8').trim(); } catch {}
  if (!token) return 0;
  const call = async (p, opt = {}) => {
    const r = await fetch(base + p, { ...opt, headers: { 'content-type': 'application/json', 'x-console-token': token }, signal: AbortSignal.timeout(15000) });
    return r.json().catch(() => ({}));
  };
  let snap;
  try { snap = await call('/api/scheduler'); } catch { return 0; }
  const tasks = Array.isArray(snap?.tasks) ? snap.tasks : [];
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  let removed = 0;
  for (const t of tasks) {
    if (!t || t.enabled !== false) continue;
    if (!t.schedule || t.schedule.type !== 'once') continue;
    const date = String(t.schedule.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= yesterday) continue;
    try {
      const r = await call(`/api/scheduler/tasks/${t.id}`, { method: 'DELETE' });
      if (r?.ok) { removed += 1; log(`清掉过期的一次性任务 #${t.id} ${t.name}`); }
    } catch {}
  }
  if (removed) log(`一次性任务清理：删了 ${removed} 条`);
  return removed;
}

backup();
await pruneFinishedTasks().catch((e) => log('清理一次性任务失败:', e.message));