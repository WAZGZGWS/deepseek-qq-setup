#!/usr/bin/env node
import { singleInstance } from '../lock/single.mjs';
singleInstance('archive');
/**
 * chat-archive —— 把她和哥的聊天全量落到 E 盘（按天一个 md），
 * 供 chat_search 工具检索，做到「换会话也不真失忆」。
 *
 * 每 60 秒拉一次最近消息，去重后追加。
 *
 * 去重键：有 seq 用 seq，没有 seq（她自己发的那半）用 time。
 * 早先只认 seq，结果她的话全被 NaN 过滤掉，档案只剩哥单方面；
 * 而且滑动窗口偶尔会把旧消息重复追加。这里改成显式 key 集合去重。
 */
import fs from 'node:fs';
import path from 'node:path';
import { STATE, stamp, today, chatKey, consoleToken as token, dirOf } from '../lib/base.mjs';

const HERE = dirOf(import.meta.url);

const OUT = path.join(HERE, 'logs');
const KEY = chatKey();
const INTERVAL = Math.max(30, Number(process.env.INTERVAL_SEC || 60)) * 1000;
const CURSOR = path.join(STATE, 'archive-cursor.json');
const KEEP_KEYS = 400;

const hhmm = (t) => new Date(t).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 5);

function readCursor() {
  try { return JSON.parse(fs.readFileSync(CURSOR, 'utf8')); } catch { return {}; }
}
function writeCursor(v) {
  try { fs.writeFileSync(CURSOR, JSON.stringify(v)); } catch {}
}

function log(...a) {
  const line = `[${stamp()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(STATE, 'archive.log'), line + '\n'); } catch {}
}

function clean(s) {
  return String(s || '').replace(/\r/g, '').replace(/\n+/g, ' ').trim().slice(0, 500);
}

// 一条消息的稳定去重键
function msgKey(m) {
  // key 必须**全局唯一**，不能只用 seq。
  // 2026-10-28 的坑：哥那边消息带的是 seq，但 seq 是「每个会话/每次桥接重启重新计数」的，
  // 于是今天的 s3、s4 和昨天档案里的 s3、s4 撞在一起，seen 一判就当成"已归档"跳过 ——
  // 档案里永远只有她自己的话。把时间戳拼进去就不会撞了。
  const t = Number(m.time || 0);
  if (m.seq !== undefined && m.seq !== null && Number.isFinite(Number(m.seq))) {
    return `s${Number(m.seq)}@${t}`;
  }
  if (m.messageId) return `i${m.messageId}@${t}`;
  if (t) return `t${t}`;
  return '';
}

// 游标丢了/是旧格式时，从已有档案的最后一行时间推断归档水位，
// 免得把整天消息重新刷一遍（state 目录 ACL 收紧后未必写得进去）。
function inferLastTime(day) {
  try {
    const file = path.join(OUT, `${day}.md`);
    if (!fs.existsSync(file)) return 0;
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    let last = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^- (\d{2}):(\d{2})\s/);
      if (m) {
        const t = new Date(`${day}T${m[1]}:${m[2]}:59+08:00`).getTime();
        if (Number.isFinite(t)) last = Math.max(last, t);
      }
    }
    return last;
  } catch { return 0; }
}

/**
 * 她自己的昵称：开机问一次 NapCat（get_login_info 里有 nickname），问不到用「机器人」。
 *
 * 这里**绝不能写死**：仓库要脱敏成 <BOT_NAME>，本机要真名。写死的结果是
 * 2026-10-28 那次 —— 把仓库的脱敏版同步到本机，档案里她的话全变成「**<BOT_NAME>**」，
 * 整整一天的记录都成了占位符。名字只能运行时取。
 */
let selfName = '';
let selfId = 0;
async function resolveSelfName() {
  try {
    const r = await fetch('http://127.0.0.1:3000/get_login_info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    const n = String(j?.data?.nickname || '').trim();
    if (n) selfName = n;
    selfId = Number(j?.data?.user_id || 0) || 0;
  } catch {}
  if (!selfName) selfName = process.env.ARCHIVE_SELF_NAME || '机器人';
}

/**
 * 从 NapCat 直接拉私聊历史（OneBot get_friend_msg_history）。
 *
 * 为什么需要这条路：桥接的 /api/socialV2/recent 是**内存里最近消息**，桥接一重启就空了，
 * 于是那段时间的聊天永远进不了档案（2026-10-29 实测：09:44 之后档案停更，
 * 而桥接 21:38 重启过，recent 直接返回 0 条）。QQ 自己的历史是持久的，
 * 拿它当第二数据源，桥接丢没丢都不影响档案。
 */
async function fetchOneBotHistory(limit = 100) {
  const owner = String(KEY).startsWith('private:') ? String(KEY).slice('private:'.length) : '';
  if (!owner) return [];
  try {
    const r = await fetch('http://127.0.0.1:3000/get_friend_msg_history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: Number(owner), count: limit }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    const list = Array.isArray(j?.data?.messages) ? j.data.messages : [];
    return list.map((m) => {
      const uid = Number(m?.sender?.user_id || 0);
      const text = (Array.isArray(m?.message) ? m.message : [])
        .map((seg) => {
          if (!seg || typeof seg !== 'object') return '';
          if (seg.type === 'text') return String(seg.data?.text || '');
          if (seg.type === 'image') return '[图片]';
          if (seg.type === 'face') return '[表情]';
          return '';
        })
        .join('')
        .trim();
      return {
        // OneBot 的 time 正常是「秒」，但个别实现/patch 会给毫秒 —— 按量级判断，别盲乘 1000
        time: (() => { const raw = Number(m?.time || 0); if (!raw) return 0; return raw > 1e12 ? raw : raw * 1000; })(),
        messageId: m?.message_id,
        isSelf: selfId ? uid === selfId : false,
        isOwner: !selfId ? true : uid !== selfId,
        plain: text,
      };
    }).filter((m) => m.plain);
  } catch {
    return [];
  }
}

async function tick() {
  const r = await fetch(`http://127.0.0.1:3100/api/socialV2/recent?key=${encodeURIComponent(KEY)}&limit=80`, {
    headers: { 'x-console-token': token() },
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  const bridgeMsgs = Array.isArray(j.messages) ? j.messages : [];
  // 桥接那份可能因为重启而空/不全：再拉一份 QQ 自己的历史，两边合并去重。
  const seenText = new Set(bridgeMsgs.map((m) => `${Number(m.time || 0)}|${String(m.plain || m.text || '').trim()}`));
  const historyMsgs = (await fetchOneBotHistory()).filter((m) => !seenText.has(`${m.time}|${String(m.plain || '').trim()}`));
  const msgs = [...bridgeMsgs, ...historyMsgs];
  if (historyMsgs.length) log(`桥接 recent 只有 ${bridgeMsgs.length} 条，另从 QQ 历史补 ${historyMsgs.length} 条`);

  const cursor = readCursor();
  const st = cursor[KEY] && typeof cursor[KEY] === 'object' ? cursor[KEY] : null;
  let seen = new Set(Array.isArray(st?.seen) ? st.seen : []);
  // 兼容老格式：**只有在游标还是旧格式（一个数字）时才启用**。
  // 2026-10-28 的 bug：新格式里也存了 maxSeq，于是这条"老游标兜底"把
  // 所有带 seq 的消息（恰好都是哥发的）永久跳过 —— 两天的档案里只有她自己的话。
  const legacySeq = st ? 0 : Number(cursor[KEY] || 0);
  // 已归档到的最后时间：比它早的一律不补，防止重建/换会话后把旧消息再刷一遍
  const lastTime = Number(st?.lastTime || 0) || inferLastTime(today());

  // 按时间排序（seq 只在哥的消息上有，不能作为全局序）
  const ordered = msgs
    .filter((m) => m && (m.plain || m.text))
    .sort((a, b) => Number(a.time || 0) - Number(b.time || 0));

  const lines = [];
  let added = 0;
  let maxTime = lastTime;
  for (const m of ordered) {
    const key = msgKey(m);
    if (!key) continue;
    if (seen.has(key)) continue;
    const mt = Number(m.time || 0);
    // 比已归档水位还早的：只记 key，不写文件（防重复刷旧消息）
    if (lastTime && mt <= lastTime) { seen.add(key); continue; }
    // 老游标兜底：比已知最大 seq 小的旧消息不再补写
    if (key.startsWith('s') && legacySeq && Number(key.slice(1)) <= legacySeq) {
      seen.add(key);
      continue;
    }
    seen.add(key);
    added += 1;
    maxTime = Math.max(maxTime, mt);
    const who = m.isSelf ? selfName : (m.isOwner ? '哥' : (m.sender || m.userId || '?'));
    const text = clean(m.plain || m.text);
    const t = m.time ? hhmm(m.time) : '';
    lines.push(`- ${t} **${who}**：${text}`);
  }

  if (lines.length) {
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `${today()}.md`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, `# ${today()} 聊天记录\n\n`);
    fs.appendFileSync(file, lines.join('\n') + '\n');
    log(`归档 ${added} 条 -> ${path.basename(file)}`);
  }

  // 只留最近 KEEP_KEYS 个键，文件不无限膨胀
  const all = Array.from(seen);
  cursor[KEY] = { seen: all.slice(-KEEP_KEYS), maxSeq: legacySeq, lastTime: maxTime, updatedAt: Date.now() };
  writeCursor(cursor);
}

/**
 * --rebuild：用 QQ 历史整份重建今天的档案，然后重置游标。
 *
 * 什么时候用：桥接重启把 recent 丢了、或者游标把一批消息错标成"已归档"，
 * 档案就会出现一天里中间断一大截（2026-10-29 就是这样：09:44 之后全空）。
 * 重建按「时间+谁+原话」去重，重复跑也不会写重复行。
 */
async function rebuild() {
  const day = today();
  const file = path.join(OUT, `${day}.md`);
  const byLine = new Map();
  const keys = [];
  const collect = (m) => {
    const text = clean(m.plain || m.text);
    const mt = Number(m.time || 0);
    if (!text || !mt) return;
    // 只重建「今天」：QQ 历史里昨天/前天的消息时间戳没带日期，混进来会排在今天同名的时刻上
    if (new Date(mt).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) !== day) return;
    const who = m.isSelf ? selfName : (m.isOwner ? '哥' : (m.sender || m.userId || '?'));
    const line = `- ${hhmm(mt)} **${who}**：${text}`;
    byLine.set(line, mt);
    const k = msgKey(m);
    if (k) keys.push(k);
  };

  const r = await fetch(`http://127.0.0.1:3100/api/socialV2/recent?key=${encodeURIComponent(KEY)}&limit=80`, {
    headers: { 'x-console-token': token() },
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (r?.ok) {
    const j = await r.json().catch(() => ({}));
    for (const m of Array.isArray(j.messages) ? j.messages : []) collect(m);
  }
  for (const m of await fetchOneBotHistory(200)) collect(m);

  // 按行里的 HH:mm 排（直接比时间戳会被秒/毫秒混用坑到），同分钟保持原顺序
  const lines = [...byLine.entries()]
    .sort((a, b) => String(a[0]).slice(2, 7).localeCompare(String(b[0]).slice(2, 7)) || a[1] - b[1])
    .map(([line]) => line);
  if (!lines.length) { log('重建失败：一条消息都没拿到（QQ 在线吗？）'); return; }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(file, `# ${day} 聊天记录\n\n${lines.join('\n')}\n`);
  const maxTime = Math.max(...[...byLine.values()]);
  const cursor = readCursor();
  cursor[KEY] = { seen: keys.slice(-KEEP_KEYS), maxSeq: 0, lastTime: maxTime, updatedAt: Date.now() };
  writeCursor(cursor);
  log(`已重建 ${day} 档案：${lines.length} 行（最晚 ${hhmm(maxTime)}），游标同步重置`);
}

const REBUILD = process.argv.includes('--rebuild');
const ONCE = process.argv.includes('--once');

await resolveSelfName();
if (REBUILD) {
  await rebuild();
  process.exit(0);
}
log(`聊天归档${ONCE ? '（单次）' : ''}启动：${KEY} → ${OUT}，每 ${INTERVAL / 1000}s`);
await tick().catch((e) => log('首次归档失败:', e.message));
if (ONCE) process.exit(0);
setInterval(() => void tick().catch((e) => log('归档失败:', e.message)), INTERVAL);
