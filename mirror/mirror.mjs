#!/usr/bin/env node
/**
 * mirror —— 镜子：从聊天里照出「他喜欢什么、烦什么」。
 *
 * 他吐槽过「客服腔」「刷屏」「太长」，夸过「这样好」「笑死」，但这些散在几万行档案里，
 * 角色卡和记忆都留不住。这里每天扫最近 7 天的档案，只做**规则统计**（不花钱、不瞎解读）：
 * 他说的话里带「别 / 不要 / 烦 / 无语 / 太长 / 客服」→ 记为不喜欢；带「哈哈 / 笑死 / 可爱 / 记得」
 * → 记为喜欢。同一句只算一次，最多各留 6 条，写 state/taste.json。
 *
 * 桥接组提示词时会注入【他的偏好】——只是参考，不是命令（她可以不听，但不能说不知道）。
 *
 * 用法：node mirror/mirror.mjs  |  --once  |  --status
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE, stamp } from '../lib/base.mjs';

const NAME = 'mirror';
const LOCK = path.join(STATE, `${NAME}.lock`);
const OUT = path.join(STATE, 'taste.json');
const TICK_MS = 6 * 3600 * 1000;
const DAYS = 7;
const MAX_ITEMS = 6;

const ONCE = process.argv.includes('--once');
const STATUS_ONLY = process.argv.includes('--status');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function readPid(p) { try { return Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch { return 0; } }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

const DISLIKE_RE = /别(?:再|老|总)?|不要|讨厌|烦|无语|怎么老|又(?:来|是)|太长|看不懂|刷屏|客服|机器人|重复|敷衍|没意思/;
// 「要不要吃点啥」是在问她，不是嫌弃：这种中性问句先放过
const NEUTRAL_RE = /要不要|不只|别急|别怕|别客气/;
const LIKE_RE = /哈哈|笑死|可爱|真棒|好听|谢谢|记得|乖|不错|挺好|喜欢/;

/** 只取他说的那一半：档案行是 `- 21:32 **说话人**：内容`，这里用「不是她的名字」不行，
 *  所以按「说的人是不是最频繁的另一个」也不稳 —— 干脆全取，再用关键词过滤，
 *  因为关键词本身大多是他在吐槽/夸。 */
/**
 * 谁是她：config 里的 mustReplyKeywords（她的别名，例如 QQ 昵称）会出现在档案的说话人里。
 * 剩下的那个就是他 —— 只看他说的话，才不会把她的台词当成「他的偏好」。
 */
function herLabels() {
  const aliases = [];
  try {
    const cfgPath = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    for (const k of cfg?.social?.mustReplyKeywords || []) aliases.push(String(k));
    for (const k of cfg?.socialV2?.selfAliases || []) aliases.push(String(k));
  } catch {}
  return aliases.filter(Boolean);
}

function scan() {
  const logs = path.join(ROOT, 'archive', 'logs');
  let files = [];
  try { files = fs.readdirSync(logs).filter((f) => f.endsWith('.md')).sort().slice(-DAYS); } catch { return { likes: [], dislikes: [], days: 0, ok: false }; }

  const aliases = herLabels();
  const rows = [];
  for (const f of files) {
    try {
      for (const line of fs.readFileSync(path.join(logs, f), 'utf8').split('\n')) {
        const m = line.match(/^- \d{1,2}:\d{2} \*\*([^*]+)\*\*：(.*)$/);
        if (m) rows.push({ who: m[1].trim(), text: m[2].trim() });
      }
    } catch {}
  }
  if (!rows.length) return { likes: [], dislikes: [], days: files.length, ok: false };

  const labels = [...new Set(rows.map((r) => r.who))];
  const hers = new Set(labels.filter((l) => aliases.some((a) => a.includes(l) || l.includes(a))));
  if (!hers.size) return { likes: [], dislikes: [], days: files.length, ok: false, labels };

  const likeCount = new Map();
  const dislikeCount = new Map();
  const around = (text, re) => {
    const m = re.exec(text);
    if (!m) return '';
    const start = Math.max(0, m.index - 8);
    const end = Math.min(text.length, m.index + m[0].length + 14);
    return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
  };
  const bump = (map, text) => {
    if (!text) return;
    const key = text.slice(0, 40);
    const cur = map.get(key) || { text: key, n: 0 };
    cur.n += 1;
    map.set(key, cur);
  };

  for (const r of rows) {
    if (hers.has(r.who)) continue; // 只记他说的
    if (!r.text || r.text.length > 150) continue;
    if (r.text.startsWith('[')) continue;
    const neutral = NEUTRAL_RE.test(r.text) && !/太长|看不懂|刷屏|客服|机器人|敷衍|没意思/.test(r.text);
    if (neutral || /别忘了|别忘/.test(r.text)) continue;
    if (DISLIKE_RE.test(r.text)) bump(dislikeCount, around(r.text, DISLIKE_RE));
    else if (LIKE_RE.test(r.text)) bump(likeCount, around(r.text, LIKE_RE));
  }

  const top = (map) => [...map.values()].sort((a, b) => b.n - a.n).slice(0, MAX_ITEMS).map((x) => x.text);
  return { likes: top(likeCount), dislikes: top(dislikeCount), days: files.length, ok: true };
}
function refresh() {
  const r = scan();
  const out = { at: new Date().toISOString(), days: r.days, likes: r.likes, dislikes: r.dislikes };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[${stamp()}] 镜子：看了 ${r.days} 天，喜欢 ${r.likes.length} 条 / 不喜欢 ${r.dislikes.length} 条`);
}

function printStatus() {
  const t = readJson(OUT);
  if (!t) { console.log('镜子还没跑过'); return; }
  console.log(`镜子（${new Date(t.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}，看了 ${t.days} 天）`);
  console.log('  喜欢：' + (t.likes.join('、') || '（还没看出来）'));
  console.log('  不喜欢：' + (t.dislikes.join('、') || '（还没看出来）'));
}

async function main() {
  if (STATUS_ONLY) { printStatus(); return; }
  if (ONCE) { refresh(); return; }
  const old = readPid(LOCK);
  if (old && old !== process.pid && pidAlive(old)) { console.log('镜子已有实例在跑'); process.exit(3); }
  fs.writeFileSync(LOCK, String(process.pid));
  const beat = setInterval(() => { try { fs.writeFileSync(LOCK, String(process.pid)); } catch {} }, 20000);
  beat.unref?.();
  process.on('exit', () => { try { if (readPid(LOCK) === process.pid) fs.unlinkSync(LOCK); } catch {} });

  for (;;) {
    try {
      const t = readJson(OUT);
      const stale = !t || !t.at || Date.now() - Date.parse(t.at) > 20 * 3600 * 1000;
      if (stale) refresh();
    } catch (e) { console.log(`[${stamp()}] 镜子出错：${e.message}`); }
    await sleep(TICK_MS);
  }
}

main();
