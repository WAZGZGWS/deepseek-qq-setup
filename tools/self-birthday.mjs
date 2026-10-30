#!/usr/bin/env node
/**
 * self-birthday —— 让她「自己定生日」这件事真正闭环。
 *
 * 为什么单独做：
 *   哥说「让她自己设属于自己的生日」。但如果只让她在聊天里说一句，
 *   过两个月谁都想不起来；生日这种东西必须是**每年自己回来**的。
 *
 * 两步，互不耦合：
 *   1) 她自己定：按时唤醒她，让她挑一个自己喜欢的日子，
 *      用 qq_memory_append 记一条 fact「我的生日是X月X日」——日期是她选的，不是我们写死
 *   2) 本脚本每天扫一次记忆：一旦看到那条 fact，就保证 scheduler 里有一个
 *      每年循环的「她的生日」任务；哪天她改主意了，这里会跟着改
 *
 * 用法：node tools/self-birthday.mjs [--dry]
 */
import fs from 'node:fs';
import { consoleApi as api, chatKey, stamp } from '../lib/base.mjs';

const DRY = process.argv.includes('--dry');
const KEY = chatKey();
const TASK_NAME = '她的生日';
const LOG = 'state/self-birthday.log';

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(new URL(`../${LOG}`, import.meta.url), line + '\n'); } catch {}
}

const mem = async () => (await api(`/api/socialV2/memory?key=${encodeURIComponent(KEY)}`)).body?.raw || {};
const tasks = async () => (await api('/api/scheduler')).body?.tasks || [];

/** 从她的记忆里找他自己的生日：只认「我的生日是X月X日」这一种说法 */
function findBirthday(raw) {
  for (const f of raw.facts || []) {
    const t = String((typeof f === 'string' ? f : f && f.text) || '');
    const m = /我(?:自己)?的?生日是\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/.exec(t);
    if (!m) continue;
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;
    return { mmdd: `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, text: t };
  }
  return null;
}

// 生日这天的特别许可：平时角色卡写着「没话说的日子一条不发」，
// 但生日是例外 —— 明确允许她发一条说说，AI 才不会因为「怕像完成任务」而错过这天。
const INSTRUCTION =
  '今天是你的生日（你自己定的那天）。' +
  '① 先跟哥说一句：你怎么过、或者现在什么心情，随口说，别写成长篇；也别向哥要礼物，他要是主动提就接住。' +
  '② 今天**允许你发一条说说**（qzone_publish），写生日当天真在想的事，10~40 字，别写成生日祝福文案；发完不用解释。';

const raw = await mem();
const bd = findBirthday(raw);
if (!bd) {
  log('她还没给自己定生日（记忆里没有「我的生日是X月X日」）');
  process.exit(0);
}

const list = await tasks();
const existing = list.find((t) => t && t.name === TASK_NAME);
const sameDate = existing && existing.schedule && Array.isArray(existing.schedule.dates) && existing.schedule.dates.includes(bd.mmdd);

if (sameDate) {
  log(`已就绪：她的生日 ${bd.mmdd}（任务 #${existing.id}）`);
  process.exit(0);
}

if (DRY) {
  log(`[dry-run] 会${existing ? '改' : '建'}「${TASK_NAME}」→ ${bd.mmdd}（依据记忆：${bd.text}）`);
  process.exit(0);
}

const schedule = { type: 'yearly', dates: [bd.mmdd], times: ['09:00'] };
if (existing) {
  const r = await api(`/api/scheduler/tasks/${existing.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ instruction: INSTRUCTION, schedule }),
  });
  log(r.body?.ok ? `已把「${TASK_NAME}」改到 ${bd.mmdd}` : `改任务失败：${JSON.stringify(r.body).slice(0, 120)}`);
} else {
  const r = await api('/api/scheduler/tasks', {
    method: 'POST',
    body: JSON.stringify({ name: TASK_NAME, kind: 'ai', instruction: INSTRUCTION, targets: [KEY], schedule }),
  });
  log(r.body?.ok ? `已建「${TASK_NAME}」→ 每年 ${bd.mmdd}（任务 #${r.body?.task?.id}）` : `建任务失败：${JSON.stringify(r.body).slice(0, 120)}`);
}
