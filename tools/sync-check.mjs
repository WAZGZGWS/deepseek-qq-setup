#!/usr/bin/env node
/**
 * sync-check —— 对比「本机跑着的这一套」和「开源仓库里的那一份」，找出漂移
 *
 * 为什么需要它：
 *   维护这类项目时，同一份脚本存在两个地方 —— 本机部署目录、GitHub 仓库（已脱敏）。
 *   改了其中一边忘了同步另一边，就会出现两种漂移：
 *     · 仓库比本机旧：新用户的版本缺功能
 *     · 本机比仓库旧：你自己跑的还是老代码（2026-10-28 真发生过，
 *       context-guard 的修复只写进仓库、忘了同步回本机）
 *   肉眼比不出来，只能逐字节比。
 *
 * 做法：把本机文件里的「真实值」（安装路径、主人 QQ、机器人 QQ…）替换成仓库里用的
 * 占位符，再和仓库逐字节比对。一致就静默，不一致就列出来。
 *
 * 用法：
 *   node tools/sync-check.mjs --live E:\qq-bot-stack --repo E:\qq-bot-stack-os
 *   node tools/sync-check.mjs --live . --repo ..\repo --verbose
 *
 * 说明：
 *   · 只比 .mjs / .cmd / .ps1，跳过 .git、node_modules、state、archive 等运行时内容
 *   · 退出码 0 = 一致；1 = 有漂移
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const get = (name, dflt = '') => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const LIVE = path.resolve(get('live', '.'));
const REPO = path.resolve(get('repo', ''));
const VERBOSE = args.includes('--verbose');
// 人名（角色名、QQ 昵称）没法从配置里推，用 --names 传，逗号分隔
const NAMES = get('names', '').split(',').map((s) => s.trim()).filter(Boolean);
// 自动补上当前角色名（state/current-role.json）
try {
  const cur = JSON.parse(fs.readFileSync(path.join(get('live', '.'), 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'state', 'current-role.json'), 'utf8'));
  if (cur.role) NAMES.push(String(cur.role));
} catch {}
// 角色卡文件名也算名字来源：roles/妹妹.md → 妹妹（昵称之类的还得靠 --names）
for (const sub of ['roles', path.join('dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'roles')]) {
  try {
    for (const f of fs.readdirSync(path.join(get('live', '.'), sub))) {
      if (f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'readme.md') NAMES.push(path.parse(f).name);
    }
  } catch {}
}
// 桥接配置里「必须回复」的关键词，通常就是她的名字/昵称（大肥鱼这种）
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(get('live', '.'), 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'config.json'), 'utf8'));
  for (const k of cfg.social && cfg.social.mustReplyKeywords ? cfg.social.mustReplyKeywords : []) {
    if (/^[\u4e00-\u9fa5]{2,8}$/.test(k)) NAMES.push(k);
  }
} catch {}

if (!get('repo')) {
  console.error('用法: node tools/sync-check.mjs --live <部署目录> --repo <仓库目录> [--verbose]');
  process.exit(2);
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'state', 'archive', 'chat-memory', 'backups', 'versions', 'logs', 'napcat', 'dsh-qq']);
const EXTS = new Set(['.mjs', '.js', '.cmd', '.ps1']);

/** 从本机的桥接配置里读主人/机器人 QQ，用于替换 */
function readIdentities(live) {
  const out = { owner: '', bot: '' };
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(live, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'config.json'), 'utf8'));
    out.owner = String(cfg.ownerQQ || '');
  } catch {}
  try {
    const j = JSON.parse(fs.readFileSync(path.join(live, 'qzone-state.json'), 'utf8'));
    void j;
  } catch {}
  return out;
}

/** 本机真实值 → 仓库占位符。顺序很重要（长串先替换） */
function buildMap(live, ids) {
  const pairs = [
    // Windows 路径：JS 字符串里是双反斜杠，先处理这种
    [live.replace(/\\/g, '\\\\'), '<STACK_ROOT>'],
    [live.replace(/\\/g, '/'), '<STACK_ROOT>'],
    [live, '<STACK_ROOT>'],
    ['E:\\nodejs\\node.exe', 'node'],
    ['E:/nodejs/node.exe', 'node'],
    ['E:\\nodejs\\node.exe'.replace(/\\/g, '\\\\'), 'node'],
  ];
  if (ids.owner) pairs.push([ids.owner, 'YOUR_QQ']);
  if (ids.bot) pairs.push([ids.bot, 'YOUR_BOT_QQ']);
  // 用户名：从 USERPROFILE 里取最后一段
  const user = (process.env.USERPROFILE || '').split(/[\\/]/).filter(Boolean).pop();
  if (user) pairs.push([user, 'YOUR_PC']);
  // 人名：仓库里统一脱敏成 <BOT_NAME>，比较前两边都抹平成 <NAME>
  for (const n of NAMES) if (n) pairs.push([n, '<NAME>']);
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

function normalize(text, pairs) {
  let t = text;
  for (const [from, to] of pairs) t = t.split(from).join(to);
  // 仓库里 <BOT_NAME> 之类的人名占位符没法反推，统一抹平后比较
  t = t.replace(/<BOT_NAME>/g, '<NAME>');
  return t;
}

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(path.join(dir, e.name));
      } else if (EXTS.has(path.extname(e.name).toLowerCase())) {
        out.push(path.join(dir, e.name));
      }
    }
  }
  return out;
}

const ids = readIdentities(LIVE);
const pairs = buildMap(LIVE, ids);

const liveFiles = walk(LIVE);
const drift = [];
const onlyLive = [];
const onlyRepo = [];

for (const f of liveFiles) {
  const rel = path.relative(LIVE, f);
  const repoFile = path.join(REPO, rel);
  if (!fs.existsSync(repoFile)) { onlyLive.push(rel); continue; }
  const liveTxt = normalize(fs.readFileSync(f, 'utf8'), pairs);
  // 两边都要归一化：仓库里也有 <BOT_NAME> 这类占位符，不抹平的话永远对不上
  const repoTxt = normalize(fs.readFileSync(repoFile, 'utf8'), pairs);
  if (liveTxt !== repoTxt) drift.push(rel);
}

// 反向：仓库有、本机没有的脚本
// 安装器 / 维护工具本来就只放仓库，本机不装，不算漂移
const REPO_ONLY_OK = [/^install\.(cmd|ps1)$/, /^tools[\\/]/, /^readme\.md$/i, /^license$/i, /[\\/]run\.cmd$/];
for (const f of walk(REPO)) {
  const rel = path.relative(REPO, f);
  if (fs.existsSync(path.join(LIVE, rel))) continue;
  if (REPO_ONLY_OK.some((re) => re.test(rel))) continue;
  onlyRepo.push(rel);
}

const show = (title, list) => {
  if (!list.length) return;
  console.log(`\n${title}（${list.length}）`);
  for (const x of list.sort()) console.log('  ' + x);
};

if (!drift.length && !onlyRepo.length) {
  if (VERBOSE) console.log(`一致：本机与仓库没有漂移${onlyLive.length ? `（本机多 ${onlyLive.length} 个老文件，仓库不收）` : ''}`);
  process.exit(0);
}

console.log(`本机 ${LIVE}`);
console.log(`仓库 ${REPO}`);
if (ids.owner) console.log(`按占位符替换：主人 QQ=${ids.owner}${ids.bot ? ' 机器人=' + ids.bot : ''}`);

show('内容不一致（需要双向同步）', drift);
show('只在仓库里有（本机缺）', onlyRepo);
show('只在本机有（仓库没收录，多为老部署遗留）', onlyLive);

if (drift.length) {
  console.log('\n提示：只差几处昵称/人名时，用 --names 妹妹,大肥鱼 补上再比一次，别急着手改。');
}

console.log('\n提示：不一致的那几个，先看清哪边更新，再把新的那份同步过去，别盲目覆盖。');
process.exit(1);
