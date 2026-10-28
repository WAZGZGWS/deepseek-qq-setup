#!/usr/bin/env node
/**
 * versions —— 没装 git 也能有版本历史（穷人版 git）
 *
 * 每次运行时算角色卡/config/预设的指纹；有变化就把它们复制到 versions/<时间>/。
 * 只保留最近 30 份。
 *
 * 用法：node versions.mjs             # 检测并快照
 *       node versions.mjs --list      # 列出历史版本
 *       node versions.mjs --restore <时间目录名>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');
const VERS = path.join(ROOT, 'versions');
const KEEP = 30;

const TRACK = [
  path.join(BRIDGE, 'roles'),
  path.join(BRIDGE, 'config.json'),
  path.join(BRIDGE, 'plugins', 'qq-agent-presets', 'presets'),
];

function collect() {
  const out = [];
  for (const t of TRACK) {
    if (!fs.existsSync(t)) continue;
    const stat = fs.statSync(t);
    if (stat.isDirectory()) {
      for (const f of fs.readdirSync(t)) {
        const p = path.join(t, f);
        if (fs.statSync(p).isFile()) out.push(p);
      }
    } else {
      out.push(t);
    }
  }
  return out;
}

function fingerprint(files) {
  const h = crypto.createHash('sha256');
  for (const f of files.sort()) {
    h.update(path.relative(BRIDGE, f));
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex');
}

const args = process.argv.slice(2);

if (args.includes('--list')) {
  if (!fs.existsSync(VERS)) { console.log('还没有历史版本'); process.exit(0); }
  const dirs = fs.readdirSync(VERS).filter((n) => {
    try { return fs.statSync(path.join(VERS, n)).isDirectory(); } catch { return false; }
  }).sort();
  if (!dirs.length) { console.log('还没有历史版本'); process.exit(0); }
  for (const d of dirs) {
    const files = fs.readdirSync(path.join(VERS, d)).length;
    console.log(d, `(${files} 项)`);
  }
  process.exit(0);
}

const restoreIdx = args.indexOf('--restore');
if (restoreIdx >= 0) {
  const name = args[restoreIdx + 1];
  const dir = path.join(VERS, name);
  if (!dir || !fs.existsSync(dir)) { console.error('没有这个版本:', name); process.exit(1); }
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const src = path.join(dir, f.name);
    const dst = f.name === 'config.json' ? path.join(BRIDGE, 'config.json')
      : f.name === 'presets' ? path.join(BRIDGE, 'plugins', 'qq-agent-presets', 'presets')
      : path.join(BRIDGE, 'roles', f.name);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, force: true });
    console.log('还原', f.name, '->', dst);
  }
  process.exit(0);
}

const files = collect();
const fp = fingerprint(files);
const marker = path.join(VERS, '.last');
let last = '';
try { last = fs.readFileSync(marker, 'utf8').trim(); } catch {}
if (fp === last) { console.log('无变化'); process.exit(0); }

const name = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/[: ]/g, '-');
const dir = path.join(VERS, name);
fs.mkdirSync(dir, { recursive: true });
for (const f of files) {
  const base = path.basename(f);
  const isConfig = base === 'config.json';
  const isPreset = f.includes(path.join('presets'));
  const target = isConfig ? path.join(dir, 'config.json')
    : isPreset ? path.join(dir, 'presets', base)
    : path.join(dir, base);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(f, target);
}
fs.mkdirSync(VERS, { recursive: true });
fs.writeFileSync(marker, fp);
console.log('已记录版本', name, `(${files.length} 个文件)`);

const dirs = fs.readdirSync(VERS).filter((n) => /^\d{4}-\d{2}-\d{2}-/.test(n)).sort();
while (dirs.length > KEEP) {
  const victim = dirs.shift();
  fs.rmSync(path.join(VERS, victim), { recursive: true, force: true });
  console.log('清理旧版本', victim);
}
