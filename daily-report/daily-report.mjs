#!/usr/bin/env node
/**
 * daily-report —— 每天一份「她今天花了多少」的小结
 *
 * 读:
 *   state/token-usage.jsonl   每次请求的用量（k=turn 才是单次，k=base 是累计快照，跳过）
 *   https://api.deepseek.com/user/balance  余额
 * 写:
 *   reports/YYYY-MM-DD.md
 *
 * 用法: node daily-report.mjs          # 打印今天的
 *       node daily-report.mjs 2026-10-26
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRIDGE, today, PRICE, dirOf } from '../lib/base.mjs';

const HERE = dirOf(import.meta.url);

const REPORTS = path.join(HERE, '..', 'reports');

const dayArg = process.argv[2];
const day = dayArg || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

// DeepSeek 官方价（元 / 百万 token）——按需改

function readKey() {
  // 以文件为准：用户级环境变量里可能躺着失效的旧 key，会盖掉文件里的有效值
  try {
    const t = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const m = t.match(/DEEPSEEK_API_KEY:\s*(sk-[A-Za-z0-9_-]+)/);
    if (m) return m[1];
  } catch {}
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  throw new Error('找不到 DEEPSEEK_API_KEY');
}

async function balance() {
  try {
    const r = await fetch('https://api.deepseek.com/user/balance', { headers: { authorization: `Bearer ${readKey()}` } });
    const j = await r.json();
    const c = (j.balance_infos || [])[0];
    return c ? `${c.total_balance} ${c.currency}` : '未知';
  } catch (e) {
    return `查询失败: ${e.message}`;
  }
}

function stats() {
  const file = path.join(BRIDGE, 'state', 'token-usage.jsonl');
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const turns = rows.filter((r) => r.k === 'turn');
  const today = turns.filter((r) => new Date(r.t).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) === day);

  const sum = { calls: 0, cacheHit: 0, cacheMiss: 0, output: 0, ctx: 0 };
  for (const r of today) {
    const b = r.b || {};
    sum.calls += 1;
    sum.cacheHit += b.cacheHit || 0;
    sum.cacheMiss += b.cacheMiss || 0;
    sum.output += b.output || 0;
    sum.ctx += (b.cacheHit || 0) + (b.cacheMiss || 0);
  }
  const cost = (sum.cacheHit / 1e6) * PRICE.cacheHit + (sum.cacheMiss / 1e6) * PRICE.cacheMiss + (sum.output / 1e6) * PRICE.output;
  const keys = new Set(today.map((r) => r.key));
  return { ...sum, cost, avgCtx: sum.calls ? sum.ctx / sum.calls : 0, chats: keys.size };
}

const s = stats();
const WARN_CTX = 50000; // 平均上下文超过这个就提醒压缩
const warn = s.avgCtx > WARN_CTX
  ? '\n> !! 平均上下文 ' + Math.round(s.avgCtx).toLocaleString() + ' tokens，超过 ' + WARN_CTX.toLocaleString() + '，建议发一次 /compact'
  : '';
const bal = await balance();

const text = [
  `# ${day} 小结`,
  '',
  `- 余额：**${bal}**`,
  `- 请求次数：${s.calls}`,
  `- 平均上下文：${Math.round(s.avgCtx).toLocaleString()} tokens`,
  `- 输入（缓存命中 / 未命中）：${s.cacheHit.toLocaleString()} / ${s.cacheMiss.toLocaleString()}`,
  `- 输出：${s.output.toLocaleString()}`,
  `- 估算花费：**${s.cost.toFixed(2)} 元**`,
  `- 涉及会话：${s.chats}`,
  '',
  warn,
  '',
  '> 估算按 DeepSeek 官方价（缓存命中 0.2 / 未命中 2 / 输出 8 元每百万 token），仅供参考。',
].join('\n');

fs.mkdirSync(REPORTS, { recursive: true });
fs.writeFileSync(path.join(REPORTS, `${day}.md`), text);
console.log(text);
