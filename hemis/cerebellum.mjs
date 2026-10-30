/**
 * 小脑 —— 记忆、输入输出、余额。
 *
 * 它管的事情都很「慢」：记忆会攒脏、摘要会漏、余额会掉。这类问题不该等出事再查，
 * 所以要有个每天醒几次的角色主动去看。和左右脑一样：只提 proposal，动手由主脑来。
 *
 * 具体管四件：
 *   1. 记忆自动存取 —— 每天的记忆摘要有没有生成（archive/summary/<日期>.md）
 *   2. 记忆优化     —— 体积/条数涨到预算边上、或出现 [object Object] 这类脏数据 → 整理
 *   3. 输出方式     —— 她在聊天里是不是越来越长/越来越密（从档案统计），超了就记一笔
 *   4. 余额         —— 低于阈值就降主动、给哥发一次提醒（每天最多一次）
 *
 * 所有动作都有冷却（存在 state/cerebellum.json），主脑重启也不会连着触发。
 */

export const INFO = { name: '小脑', role: '记忆/输入输出/余额', version: 1 };

import fs from 'node:fs';
import path from 'node:path';

const MEM_BUDGET_CHARS = 4500;        // 记忆体积预算（提示词里那一段）
const TIDY_COOLDOWN_MS = 6 * 3600 * 1000;
const SUMMARY_COOLDOWN_MS = 6 * 3600 * 1000;
const MAIL_COOLDOWN_MS = 24 * 3600 * 1000;
const SAVE_MODE_BALANCE = 2;          // 低于这个数进省着聊模式
const MAIL_BALANCE = 1;               // 低于这个数提醒充值

function tryJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function readState(root) { return tryJson(path.join(root, 'state', 'cerebellum.json')) || {}; }
function writeState(root, s) {
  try { fs.mkdirSync(path.join(root, 'state'), { recursive: true }); fs.writeFileSync(path.join(root, 'state', 'cerebellum.json'), JSON.stringify(s, null, 2)); } catch {}
}
function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

/**
 * 档案里今天的消息：条数和平均长度（看输出方式有没有走样）。
 *
 * 不按昵称过滤：昵称是个人信息，不该写进代码；而且「越聊越长、越聊越密」两个方向
 * 合计看更准。行格式：`- 21:32 **说话人**：内容`。
 */
function speechStats(root, day) {
  try {
    const text = fs.readFileSync(path.join(root, 'archive', 'logs', `${day}.md`), 'utf8');
    const rows = [...text.matchAll(/^- \d{1,2}:\d{2} \*\*[^*]+\*\*：(.*)$/gm)].map((m) => (m[1] || '').trim());
    const lens = rows.map((s) => s.length).filter((n) => n > 0);
    const avg = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0;
    const long = lens.filter((n) => n > 400).length;
    return { count: rows.length, avg, long };
  } catch { return { count: 0, avg: 0, long: 0 }; }
}

/**
 * 记忆体检（本地文件，不打扰桥接）：
 * 数一数污染字符、重复条目、核心要点有多少条 —— 发现问题才提案，动手交给右手。
 */
function memoryAudit(ctx) {
  const dir = ctx.bridgeDir || '';
  const file = path.join(dir, 'state', 'social-v2.json');
  const j = tryJson(file);
  if (!j || !j.conversations) return null;
  const keys = Object.keys(j.conversations);
  const key = keys[0];
  if (!key) return null;
  const conv = j.conversations[key] || {};
  const norm = (s) => String(s ?? '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, '')
    .replace(/[，。！？、；：""''（）()\[\]【】…—\-\s,.!?;:'"`~]/g, '')
    .toLowerCase();
  const bad = (s) => {
    const x = String(s ?? '');
    if (!x.trim()) return true;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(x)) return true;
    if (x.includes('\uFFFD')) return true;
    return norm(x).length < 2;
  };

  let facts = 0; let polluted = 0; let dup = 0;
  for (const field of ['facts', 'activeTopics', 'pendingThoughts']) {
    const list = Array.isArray(conv[field]) ? conv[field] : [];
    if (field === 'facts') facts = list.length;
    const seen = new Set();
    for (const e of list) {
      const text = String(e && e.text !== undefined ? e.text : '');
      if (bad(text)) { polluted += 1; continue; }
      const n = norm(text);
      if (seen.has(n)) dup += 1; else seen.add(n);
    }
  }
  return { key, facts, topics: (conv.activeTopics || []).length, polluted, dup };
}
/** 记忆里有没有脏数据（[object Object] / undefined 被当成事实存进去过） */
function memoryJunk(root) {
  const dir = path.join(root, 'chat-memory');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.md')); } catch { return 0; }
  let junk = 0;
  for (const f of files) {
    try {
      const t = fs.readFileSync(path.join(dir, f), 'utf8');
      junk += (t.match(/\[object Object\]/g) || []).length;
      junk += (t.match(/：undefined|:\s*undefined/g) || []).length;
    } catch {}
  }
  return junk;
}

export function plan(ctx) {
  const now = ctx.now || Date.now();
  const root = ctx.root;
  const st = readState(root) || {};
  const day = dayKey(new Date(now));
  const notes = [];
  const proposals = [];

  // ── 余额（先看，省钱模式会影响别的判断） ─────────────────────
  const bw = tryJson(path.join(root, 'state', 'balance-watch.json')) || {};
  const balance = Number(process.env.CEREB_TEST_BALANCE || bw.lastBalance || 0);
  const saveMode = balance > 0 && balance < SAVE_MODE_BALANCE;

  if (saveMode && st.saveMode !== true) {
    proposals.push({ kind: 'save-mode', why: `余额 ${balance} 元，进省着聊模式`, balance });
    notes.push(`余额 ${balance} 元`);
  }
  if (balance > 0 && balance < MAIL_BALANCE && now - (st.lastMailAt || 0) > MAIL_COOLDOWN_MS) {
    proposals.push({ kind: 'send-mail', why: `余额只剩 ${balance} 元，提醒哥充值`, balance });
  }

  // ── 记忆：每天摘要有没有按时生成 ─────────────────────────────
  const summaryDir = path.join(root, 'archive', 'summary');
  const hasSummaryToday = mtime(path.join(summaryDir, `${day}.md`)) > 0;
  const sp = speechStats(root, day);
  if (!hasSummaryToday && sp.count >= 20 && now - (st.lastSummaryAt || 0) > SUMMARY_COOLDOWN_MS) {
    proposals.push({ kind: 'run-memory-summary', why: `今天 ${sp.count} 句还没做摘要`, day });
  }

  // ── 记忆：体积/脏数据 ────────────────────────────────────────
  const ms = tryJson(path.join(ctx.bridgeState || '', 'memory-stats.json')) || {};
  const chars = Number(ms.chars || 0);
  const junk = memoryJunk(root);
  const statsAge = ms.at ? now - Date.parse(ms.at) : -1;
  const tidyDue = chars > MEM_BUDGET_CHARS * 0.9 || junk > 0 || (statsAge > 3 * 86400000 && statsAge > 0);
  if (tidyDue && now - (st.lastTidyAt || 0) > TIDY_COOLDOWN_MS) {
    proposals.push({
      kind: 'run-memory-tidy',
      why: junk > 0 ? `记忆里有 ${junk} 处脏数据` : chars > MEM_BUDGET_CHARS * 0.9 ? `记忆 ${chars} 字，快到预算 ${MEM_BUDGET_CHARS}` : `记忆统计 ${Math.round(statsAge / 86400000)} 天没更新`,
    });
  }

  // ── 记忆：污染字符 / 重复条目（动手的是右手，小脑只负责看出来） ──
  const audit = memoryAudit(ctx);
  if (audit && (audit.polluted > 0 || audit.dup > 0) && now - (st.lastCleanAt || 0) > 2 * 3600 * 1000) {
    proposals.push({
      kind: 'clean-memory',
      why: `记忆里 ${audit.polluted} 条污染 / ${audit.dup} 条重复`,
      counts: audit,
    });
  }
  if (audit) notes.push(`记忆 ${audit.facts} 条事实 / ${audit.topics} 个话题`);

  // ── 输出方式：越来越长/越来越密就记一笔（不改她的话，只让主脑知道） ──
  if (sp.count >= 20 && sp.avg > 160) notes.push(`今天平均每条 ${sp.avg} 字（偏长）`);
  if (sp.long >= 5) notes.push(`今天有 ${sp.long} 条超过 400 字`);

  return {
    online: true,
    notes,
    proposals,
    metrics: { balance, saveMode, memChars: chars, memJunk: junk, spoken: sp.count, avgLen: sp.avg, hasSummaryToday, facts: audit ? audit.facts : 0, memPolluted: audit ? audit.polluted : 0, memDup: audit ? audit.dup : 0 },
    state: st,
    key: audit ? audit.key : '',
  };
}

/** 主脑执行完回执：记冷却，避免重复触发 */
export function feedback(root, kind, ok) {
  const st = readState(root) || {};
  const now = Date.now();
  if (kind === 'run-memory-tidy' && ok) st.lastTidyAt = now;
  if (kind === 'run-memory-summary' && ok) st.lastSummaryAt = now;
  if (kind === 'send-mail' && ok) st.lastMailAt = now;
  if (kind === 'save-mode') st.saveMode = ok;
  if (kind === 'clean-memory' && ok) st.lastCleanAt = now;
  st.at = new Date().toISOString();
  writeState(root, st);
}