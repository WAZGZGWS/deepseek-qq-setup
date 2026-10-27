#!/usr/bin/env node
/**
 * memory-summary —— 每天把当天聊天压成几条要点，存进 archive/summary/。
 *
 * 为什么需要：她的短记忆只有 8 条话题 + 6 条印象，昨天聊过的事一旦滚出
 * 这个窗口，就只能靠 chat_search 搜关键词 —— 搜不准就等于忘了。
 * 这里每天生成一份「昨天聊了什么」的摘要，桥接会把它注入提示词，
 * 让她不用调工具就知道前几天发生过什么。
 *
 * 用法：node memory-summary.mjs [YYYY-MM-DD]
 * 成本：每天一次，约 0.01 元。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const ARCHIVE = path.join(ROOT, 'archive', 'logs');
const OUT = path.join(ROOT, 'archive', 'summary');
const MODEL = process.env.SUMMARY_MODEL || 'deepseek-chat';

function day(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function log(...a) {
  const line = `[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(ROOT, 'state', 'memory-summary.log'), line + '\n'); } catch {}
}

function readKey() {
  try {
    const t = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const m = t.match(/DEEPSEEK_API_KEY:\s*(sk-[A-Za-z0-9_-]+)/);
    return m ? m[1] : '';
  } catch { return ''; }
}

/** 把当天记录压成有信息量的正文（去掉纯寒暄和重复行） */
function condense(md) {
  const lines = md.split('\n').filter((l) => l.startsWith('- '));
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    const body = l.replace(/^-\s*\d{2}:\d{2}\s*\*\*[^*]+\*\*：/, '').trim();
    if (!body) continue;
    // 太短的（“嗯”“哦”“哈哈”）不带信息，跳过
    if (body.length < 8) continue;
    // 纯粹的表情/图片标记
    if (/^\[(图片|表情)\]$/.test(body)) continue;
    const key = body.slice(0, 24);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(body);
  }
  return out;
}

async function summarize(dayStr, bodies) {
  const key = readKey();
  if (!key) { log('没有 API key，跳过摘要'); return null; }

  // 把前 3 天的摘要喂进去，让它别重复已经写过的事。
  // 否则「哥 10:30 睡」这种稳定事实会每天出现一次，注入 4 天就重复 4 遍。
  const prev = [];
  for (let i = 1; i <= 3; i++) {
    const d = day(-i);
    const f = path.join(OUT, d + '.md');
    try {
      if (!fs.existsSync(f)) continue;
      const body = fs.readFileSync(f, 'utf8').replace(/^#[^\n]*\n+/, '').trim();
      if (body) prev.push('（' + d + '）\n' + body);
    } catch {}
  }
  const prevBlock = prev.length
    ? '\n\n以下是前几天的摘要。**里面已经写过的事实不要再重复**（作息、口味、工作性质这类稳定信息尤其别重复），只写今天新增的：\n' + prev.join('\n')
    : '';

  // 样本别太大：取首尾各一半，中间时段通常信息密度低
  const head = bodies.slice(0, 120);
  const tail = bodies.slice(-120);
  const sample = [...new Set([...head, ...tail])].join('\n');

  const prompt = `下面是${dayStr}这一天，一个<BOT_NAME>（<BOT_NAME>）和哥哥的聊天片段。请提炼 3~4 条「今天新增、值得长期记住」的要点，每条一行，不超过 30 字。

规则：
- 只写事实和偏好，不写评价、不总结心情、不用「记录显示」这类词
- 稳定不变的信息（作息、口味、工作性质）如果前面写过，不要重复
- 只写今天发生的、或今天才了解到的

重点关注：他在忙什么、身体状态、答应了什么事、两人之间发生的重要小事。${prevBlock}

聊天片段：
${sample.slice(0, 12000)}`;

  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 400,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) { log('摘要 API 失败:', r.status, (await r.text()).slice(0, 120)); return null; }
  const jj = await r.json();
  const text = jj?.choices?.[0]?.message?.content || '';
  const cost = ((jj?.usage?.prompt_tokens || 0) / 1e6) * 0.2 + ((jj?.usage?.completion_tokens || 0) / 1e6) * 8;
  log(`摘要完成，约 ${cost.toFixed(4)} 元（参考了 ${prev.length} 天旧摘要）`);
  return text.trim();
}

async function main() {
  const target = process.argv[2] || day(0); // 默认总结当天（23:10 跑时当天已聊完）
  const src = path.join(ARCHIVE, `${target}.md`);
  if (!fs.existsSync(src)) { log(`${target} 没有聊天记录，跳过`); return; }

  const bodies = condense(fs.readFileSync(src, 'utf8'));
  if (!bodies.length) { log(`${target} 没有有效内容，跳过`); return; }

  const text = await summarize(target, bodies);
  if (!text) return;

  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${target}.md`);
  fs.writeFileSync(file, `# ${target} 摘要\n\n${text}\n`, 'utf8');
  log(`已写入 ${file}（源 ${bodies.length} 条，抽样 ${Math.min(bodies.length, 240)} 条）`);

  // 摘要永久保留：E 盘空间管够，一天才 300 多字节，十年也就 1 MB。
  // （以前是保留 90 天，删掉的其实是"她说过的话"本身，不值得为了这点空间丢记忆）
  try {
    const keep = new Set();
    for (let i = 0; i < 3650; i++) keep.add(day(-i));
    for (const f of fs.readdirSync(OUT)) {
      if (!f.endsWith('.md')) continue;
      if (!keep.has(f.replace('.md', ''))) fs.unlinkSync(path.join(OUT, f));
    }
  } catch {}
}

await main();
