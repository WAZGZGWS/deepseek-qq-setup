#!/usr/bin/env node
/**
 * self-birthday —— 两个生日都自动回来：她自己的 + 主人的。
 *
 * 分工：
 *   她自己的生日：日期**由她自己定**（记忆里 `我的生日是X月X日`），不是我们写死；
 *                那天允许她发一条说说，怎么写由她自己决定。
 *   主人的生日：  记忆里有 `哥生日M月D日`，那天让她主动开口 + 也允许发说说；
 *                同时把两天写进 balance-watch.json 的 lenientDates —— 生日当天余额只记账不催。
 *
 * 每天跑一次（cron），谁改主意了它跟着改；--dry 只打印不动手。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleApi as api, chatKey, stamp } from '../lib/base.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DRY = process.argv.includes('--dry');
const KEY = chatKey();
const LOG = path.join(ROOT, 'state', 'self-birthday.log');

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

const mem = async () => (await api(`/api/socialV2/memory?key=${encodeURIComponent(KEY)}`)).body?.raw || {};
const tasks = async () => (await api('/api/scheduler')).body?.tasks || [];

const pad = (n) => String(n).padStart(2, '0');

/** 她的生日：只认「我的生日是X月X日」 */
function findOwn(raw) {
  for (const f of raw.facts || []) {
    const t = String((typeof f === 'string' ? f : f && f.text) || '');
    const m = /我(?:自己)?的?生日是\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/.exec(t);
    if (!m) continue;
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;
    return { mmdd: `${pad(mm)}-${pad(dd)}`, text: t };
  }
  return null;
}

/** 主人的生日：「哥生日11月20日」/「哥的生日是11月20日」 */
function findOwner(raw) {
  for (const f of raw.facts || []) {
    const t = String((typeof f === 'string' ? f : f && f.text) || '');
    const m = /哥(?:的)?生日(?:是)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/.exec(t);
    if (!m) continue;
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;
    return { mmdd: `${pad(mm)}-${pad(dd)}`, text: t };
  }
  return null;
}

const OWN_INSTRUCTION =
  '今天是你的生日（你自己定的那天）。' +
  '① 跟哥说一句：你怎么过、或者现在什么心情，随口说，别写成长篇；别向他要礼物，他主动提就接住。' +
  '② 今天**允许你发一条说说**（qzone_publish）：**按你自己的想法写**，长度、语气、写什么都随你，不用套平时的规矩；发完不用解释。';

const OWNER_INSTRUCTION =
  '今天是哥的生日。' +
  '① 主动跟他说一句生日相关的话，自然点，别像群发祝福。' +
  '② 今天**允许你发一条说说**（qzone_publish）：按你自己的想法写，长度随意。';

/** 保证某个 yearly 任务存在且日期正确 */
async function ensureYearly(name, mmdd, instruction) {
  const list = await tasks();
  const existing = list.find((t) => t && t.name === name);
  const same = existing && existing.schedule && Array.isArray(existing.schedule.dates) && existing.schedule.dates.includes(mmdd);
  if (same) {
    log(`已就绪：${name} → 每年 ${mmdd}（任务 #${existing.id}）`);
    return;
  }
  if (DRY) {
    log(`[dry-run] 会${existing ? '改' : '建'}「${name}」→ ${mmdd}`);
    return;
  }
  const schedule = { type: 'yearly', dates: [mmdd], times: ['09:00'] };
  if (existing) {
    const r = await api(`/api/scheduler/tasks/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ instruction, schedule }),
    });
    log(r.body?.ok ? `已把「${name}」改到 ${mmdd}` : `改任务失败：${JSON.stringify(r.body).slice(0, 120)}`);
  } else {
    const r = await api('/api/scheduler/tasks', {
      method: 'POST',
      body: JSON.stringify({ name, kind: 'ai', instruction, targets: [KEY], schedule }),
    });
    log(r.body?.ok ? `已建「${name}」→ 每年 ${mmdd}（任务 #${r.body?.task?.id}）` : `建任务失败：${JSON.stringify(r.body).slice(0, 120)}`);
  }
}

/** 把两个生日写进 balance-watch.json 的 lenientDates（余额只记账不催） */
function writeLenient(dates) {
  const want = [...new Set(dates.filter(Boolean))].sort();
  const file = path.join(ROOT, 'balance-watch.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const cur = Array.isArray(cfg.lenientDates) ? cfg.lenientDates.map(String).sort() : [];
  if (JSON.stringify(cur) === JSON.stringify(want)) return;
  if (DRY) { log(`[dry-run] lenientDates ${JSON.stringify(cur)} → ${JSON.stringify(want)}`); return; }
  cfg.lenientDates = want;
  cfg._说明 = '生日这两天余额提醒放宽：只记账不催（由 tools/self-birthday.mjs 维护）';
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  log(`余额放宽日已更新：${want.join(' / ')}`);
}

const raw = await mem();
const own = findOwn(raw);
const owner = findOwner(raw);

if (!own) log('她还没给自己定生日（记忆里没有「我的生日是X月X日」）');
else await ensureYearly('她的生日', own.mmdd, OWN_INSTRUCTION);

if (!owner) log('记忆里没有「哥生日X月X日」，跳过主人的生日');
else await ensureYearly('他的生日', owner.mmdd, OWNER_INSTRUCTION);

writeLenient([own && own.mmdd, owner && owner.mmdd]);
