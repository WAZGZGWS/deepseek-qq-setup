#!/usr/bin/env node
/**
 * hippocampus —— 海马体：记忆的「晋升」和「遗忘」。
 *
 * 现在记忆的问题是「只进不出」：话题一直堆着，过期的也不走；事实攒多了没人降权。
 * memory-summary 负责生成摘要，memory-tidy 负责体积，小脑负责脏数据和重复 ——
 * 还缺一层：**按时间给记忆定生死**。
 *
 * 每 6 小时看一次（规则，不花 token）：
 *   · 话题最后被提到超过 30 天 → 遗忘候选（最多一次摘 3 条，走右手：先备份再删）
 *   · 长期事实 90 天没再确认过 → 只标记为「该复核」，不自动删（事实比话题值钱）
 *   · 写完一份 state/hippocampus.json，主脑随时能看「它准备忘掉什么」
 *
 * 用法：node hippocampus/hippocampus.mjs  |  --status
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE, stamp } from '../lib/base.mjs';
import * as rightHand from '../hands/right-hand.mjs';

const NAME = 'hippocampus';
const LOCK = path.join(STATE, `${NAME}.lock`);
const OUT = path.join(STATE, 'hippocampus.json');
const LOG = path.join(STATE, 'hippocampus.log');
const TICK_MS = 6 * 3600 * 1000;
const TOPIC_FORGET_DAYS = 30;
const FACT_REVIEW_DAYS = 90;
const MAX_FORGET_PER_RUN = 3;
const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');

const STATUS_ONLY = process.argv.includes('--status');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function readPid(p) { try { return Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch { return 0; } }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function log(msg) { const line = `[${stamp()}] ${msg}`; try { fs.appendFileSync(LOG, line + '\n'); } catch {} console.log(line); }

function memoryFile() { return path.join(BRIDGE, 'state', 'social-v2.json'); }

function analyze(now) {
  const j = readJson(memoryFile());
  if (!j || !j.conversations) return { key: '', topics: [], facts: [] };
  const key = Object.keys(j.conversations)[0] || '';
  const conv = j.conversations[key] || {};
  const topics = (Array.isArray(conv.activeTopics) ? conv.activeTopics : []).map((t) => ({
    text: String(t?.text || ''),
    lastMentionAt: Number(t?.lastMentionAt) || 0,
  })).filter((t) => t.text);
  const facts = (Array.isArray(conv.facts) ? conv.facts : []).map((f) => ({
    text: String(f?.text || ''),
    addedAt: Number(f?.addedAt) || 0,
    confirmedAt: Number(f?.confirmedAt) || 0,
  })).filter((f) => f.text);
  return { key, topics, facts };
}

function printStatus() {
  const h = readJson(OUT);
  if (!h) { console.log('海马体还没跑过'); return; }
  console.log(`海马体：${new Date(h.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log(`  话题 ${h.topics} 条，事实 ${h.facts} 条；遗忘候选 ${(h.forget || []).length}，该复核 ${(h.review || []).length}`);
  for (const f of (h.forget || []).slice(0, 5)) console.log(`   遗忘：${f.text.slice(0, 40)}（${f.ageDays} 天没提）`);
}

async function main() {
  if (STATUS_ONLY) { printStatus(); return; }
  const old = readPid(LOCK);
  if (old && old !== process.pid && pidAlive(old)) { console.log('海马体已有实例在跑'); process.exit(3); }
  fs.writeFileSync(LOCK, String(process.pid));
  const beat = setInterval(() => { try { fs.writeFileSync(LOCK, String(process.pid)); } catch {} }, 20000);
  beat.unref?.();
  process.on('exit', () => { try { if (readPid(LOCK) === process.pid) fs.unlinkSync(LOCK); } catch {} });

  for (;;) {
    try {
      const now = Date.now();
      const { key, topics, facts } = analyze(now);

      const forget = topics
        .filter((t) => t.lastMentionAt && now - t.lastMentionAt > TOPIC_FORGET_DAYS * 86400000)
        .map((t) => ({ text: t.text, ageDays: Math.round((now - t.lastMentionAt) / 86400000) }))
        .sort((a, b) => b.ageDays - a.ageDays);
      const review = facts
        .filter((f) => {
          const at = f.confirmedAt || f.addedAt;
          return at && now - at > FACT_REVIEW_DAYS * 86400000;
        })
        .map((f) => ({ text: f.text.slice(0, 80), ageDays: Math.round((now - (f.confirmedAt || f.addedAt)) / 86400000) }));

      let removed = 0;
      if (key && forget.length) {
        const batch = forget.slice(0, MAX_FORGET_PER_RUN).map((f) => ({ category: 'activeTopic', content: f.text, why: `话题 ${f.ageDays} 天没提` }));
        const r = await rightHand.apply({ root: ROOT, bridgeDir: BRIDGE, key }, batch);
        removed = r.removed || 0;
        if (removed) log(`遗忘 ${removed} 个过期话题（先备份了）+ 剩 ${forget.length - removed} 个候选`);
      }

      const out = {
        at: new Date(now).toISOString(),
        key,
        topics: topics.length - removed,
        facts: facts.length,
        forget: forget.slice(removed),
        review,
        removed,
      };
      fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
      if (!removed) log(`体检：话题 ${topics.length} / 事实 ${facts.length}，遗忘候选 ${forget.length}，该复核 ${review.length}`);
    } catch (e) {
      log('海马体出错：' + e.message);
    }
    await sleep(TICK_MS);
  }
}

main();
