/**
 * 左手 —— 删无用文件和脚本。只按主脑的裁决动手。
 *
 * 铁规矩（误删比不删糟得多）：
 *   1. 不删代码、配置、状态、记忆：`*.mjs/*.js/*.json/*.md/*.yml/*.ps1/*.vk` 一律不动；
 *   2. 不删 dsh-qq（桥接本体）和 node_modules；
 *   3. 只处理「明确是垃圾」的东西：*.tmp *.bak *.old *.out *.err、轮转日志、二维码图片、旧版本目录；
 *   4. 不是真删 —— 移到 trash/<日期>/<相对路径>，附 manifest.json，随时能捞回来；
 *   5. 每次最多 200 个文件 / 300MB，超过就下一轮再说。
 */

export const INFO = { name: '左手', role: '删无用文件', version: 1 };

import fs from 'node:fs';
import path from 'node:path';

const MAX_FILES = 200;
const MAX_BYTES = 300 * 1024 * 1024;
const DAY = 86400000;

// 只在这些地方找垃圾（相对 ROOT）
const SCAN_DIRS = ['state', 'tools/qr', 'archive/old-shortcuts', 'logs', 'backups', 'versions'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dsh-qq', 'trash', 'chat-memory', 'napcat']);
const JUNK_RE = /\.(tmp|bak|old|out|err|swp)$/i;
const LOG_ROTATE_RE = /\.log\.\d+$/i;

function age(p) { try { return Date.now() - fs.statSync(p).mtimeMs; } catch { return 0; } }
function size(p) { try { return fs.statSync(p).size; } catch { return 0; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function walk(dir, out, relBase, depth = 0) {
  if (depth > 4 || !fs.existsSync(dir)) return;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    const rel = path.join(relBase, n);
    if (isDir(p)) {
      if (SKIP_DIRS.has(n)) continue;
      walk(p, out, rel, depth + 1);
    } else {
      out.push({ abs: p, rel, size: size(p), age: age(p) });
    }
  }
}

/** 版本/备份目录：只留最近 5 个，其余算垃圾 */
function oldVersionDirs(root) {
  const out = [];
  for (const sub of ['versions', 'backups']) {
    const dir = path.join(root, sub);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => isDir(path.join(dir, n))); } catch { continue; }
    const rows = names.map((n) => ({ n, at: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const r of rows.slice(5)) out.push({ abs: path.join(dir, r.n), rel: path.join(sub, r.n), size: 0, age: Date.now() - r.at, dir: true });
  }
  return out;
}

export function plan(ctx = {}) {
  const root = ctx.root;
  const candidates = [];
  for (const d of SCAN_DIRS) walk(path.join(root, d), candidates, d);

  const items = [];
  let totalBytes = 0;
  for (const c of candidates) {
    let reason = '';
    if (JUNK_RE.test(c.rel) && c.age > 3 * DAY) reason = '临时/备份残留超过 3 天';
    else if (LOG_ROTATE_RE.test(c.rel) && c.age > 7 * DAY) reason = '轮转日志超过 7 天';
    else if (/tools[\\/]qr[\\/].*\.png$/i.test(c.rel) && c.age > 2 * DAY) reason = '过期二维码图片';
    else if (/state[\\/].*brain.*\.(out|err)$/i.test(c.rel) && c.age > DAY) reason = '调试输出超过 1 天';
    if (!reason) continue;
    if (items.length >= MAX_FILES || totalBytes + c.size > MAX_BYTES) break;
    items.push({ rel: c.rel, size: c.size, ageDays: Math.round(c.age / DAY), why: reason });
    totalBytes += c.size;
  }
  for (const d of oldVersionDirs(root)) {
    if (items.length >= MAX_FILES) break;
    items.push({ rel: d.rel, size: d.size, ageDays: Math.round(d.age / DAY), why: '旧版本/备份只留最近 5 个', dir: true });
  }

  if (!items.length) return { proposals: [], metrics: { scanned: candidates.length, junk: 0, bytes: 0 } };
  return {
    proposals: [{
      kind: 'trash-files',
      why: `${items.length} 个无用文件（约 ${Math.round(totalBytes / 1048576)}MB）`,
      items,
      essential: totalBytes > 200 * 1024 * 1024, // 太大就提到保命级别，别等按规矩排队
    }],
    metrics: { scanned: candidates.length, junk: items.length, bytes: totalBytes },
  };
}

/** 执行：移到 trash/<日期>/<相对路径> + 写清单。返回移了多少、腾了多少 */
export function apply(root, items = []) {
  const day = new Date().toISOString().slice(0, 10);
  const bin = path.join(root, 'trash', day);
  const manifest = [];
  let moved = 0;
  let freed = 0;
  for (const it of items) {
    const src = path.join(root, it.rel);
    const dst = path.join(bin, it.rel);
    try {
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      moved += 1;
      freed += Number(it.size) || 0;
      manifest.push({ rel: it.rel, why: it.why, size: it.size });
    } catch {
      // 目录移动失败就试递归复制后删（跨盘/被占用时 rename 会失败）
      try {
        fs.cpSync(src, dst, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
        moved += 1; freed += Number(it.size) || 0;
        manifest.push({ rel: it.rel, why: it.why, size: it.size, copied: true });
      } catch {}
    }
  }
  if (manifest.length) {
    try {
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'manifest.json'), JSON.stringify({ at: new Date().toISOString(), items: manifest }, null, 2));
    } catch {}
  }
  return { ok: true, moved, freed, bin };
}

/** 清空很久以前的垃圾桶（默认 30 天） */
export function emptyTrash(root, keepDays = 30) {
  const bin = path.join(root, 'trash');
  let names = [];
  try { names = fs.readdirSync(bin); } catch { return { ok: true, removed: 0 }; }
  let removed = 0;
  for (const n of names) {
    const p = path.join(bin, n);
    if (age(p) < keepDays * DAY) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); removed += 1; } catch {}
  }
  return { ok: true, removed };
}
