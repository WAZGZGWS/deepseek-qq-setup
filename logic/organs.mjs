/**
 * logic/organs.mjs —— 主脑自己的三条逻辑：理性（尸检 + 清理）、创造（造工具）、喜悦（激励）。
 *
 * 三条都只**提方案**，动手的仍然是主脑（它才有 leftHand / 优先级 / 写文件的手）。
 *
 * 理性：谁死了、谁没用了，就把它挪进 trash（可捞回来），同时写一份「病因」进
 *       state/autopsy.json —— 下次它再犯同样的病，主脑能直接查历史。
 * 创造：反复出现的需求（同一类问题在决策里出现 3 次以上）→ 生成一个小工具放进 tools/gen/，
 *       只新增、绝不覆盖已有文件，也不碰核心代码（「篡改」只允许在 tools/gen 里）。
 * 喜悦：某个器官连续正常运转满 7 天 → 给它一次激励（免检 24 小时：不降它优先级、不压它频率），
 *       并记进 state/joy.json，免得天天发奖。
 */

export const INFO = { name: '主脑逻辑', role: '理性/创造/喜悦', version: 1 };

import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400000;
const AUTOPSEY = 'autopsy.json';
const JOY = 'joy.json';
const CREATED = 'created.json';

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, v) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); } catch {} }
function age(p) { try { return Date.now() - fs.statSync(p).mtimeMs; } catch { return 0; } }
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

// ── 理性：找「死掉的器官」和「没用的脚本」 ─────────────────────────

/** 这些脚本已经不参与运行了：主脑接班后的旧器官、一次性脚本。 */
const LEGACY = [
  { rel: 'stack-guard/stack-guard.mjs', why: '守夜人已被急救员取代（急救员独立于主脑）' },
  { rel: 'supervisor/supervisor.mjs', why: 'supervisor 已被主脑取代（主脑占着它的角色锁）' },
];

/** 引用检查：整仓/整机会不会还有地方提到这个文件名 */
function referenced(root, name) {
  const dirs = ['', 'supervisor', 'tools', 'stack-doctor', 'medic', 'eye', 'mouth', 'hemis', 'hands', 'logic', 'install.ps1', 'install.cmd'];
  let hits = 0;
  const scan = (p) => {
    if (!exists(p)) return;
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        for (const n of fs.readdirSync(p)) {
          if (['node_modules', '.git', 'trash', 'archive', 'state', 'versions', 'backups'].includes(n)) continue;
          scan(path.join(p, n));
        }
        return;
      }
      if (!/\.(mjs|js|ps1|cmd|bat|json|yml|yaml|md)$/i.test(p)) return;
      if (p.includes('logic')) return; // 自己这份名单不算引用
      const txt = fs.readFileSync(p, 'utf8');
      if (txt.includes(name)) hits += 1;
    } catch {}
  };
  for (const d of dirs) scan(d ? path.join(root, d) : root);
  return hits > 0;
}

export function rationalPlan(ctx) {
  const root = ctx.root || '';
  const items = [];
  const notes = [];
  for (const l of LEGACY) {
    const abs = path.join(root, l.rel);
    if (!exists(abs)) continue;
    if (referenced(root, path.basename(l.rel))) { notes.push(`${l.rel} 还被引用，先不动`); continue; }
    items.push({ rel: l.rel, why: l.why, dead: true });
  }

  // 一次性脚本：archive/oneoff 里超过 21 天没动过的
  const oneoff = path.join(root, 'archive', 'oneoff');
  if (exists(oneoff)) {
    for (const f of fs.readdirSync(oneoff)) {
      const abs = path.join(oneoff, f);
      if (!/\.(py|mjs|js|cmd|ps1)$/i.test(f)) continue;
      if (age(abs) < 21 * DAY) continue;
      items.push({ rel: path.join('archive', 'oneoff', f), why: '一次性脚本，21 天没动过', dead: true });
    }
  }

  if (!items.length) return { proposals: [], notes };
  return {
    proposals: [{
      kind: 'trash-legacy',
      why: `${items.length} 个已死/无用脚本（搬到 trash，可捞回来）`,
      items: items.map((x) => ({ rel: x.rel, why: x.why, size: 0 })),
      autopsy: items.map((x) => ({ at: new Date().toISOString(), rel: x.rel, cause: x.why, verdict: '退役' })),
    }],
    notes,
  };
}

/** 记病因：append 模式，主脑随时能查「它当年怎么死的」 */
export function recordAutopsy(stateDir, records) {
  if (!records || !records.length) return 0;
  const file = path.join(stateDir, AUTOPSEY);
  const cur = readJson(file) || { items: [] };
  for (const r of records) cur.items.push(r);
  cur.items = cur.items.slice(-200);
  writeJson(file, cur);
  return records.length;
}

// ── 创造：反复出现的需求 → 生成一个小工具 ──────────────────────────

const TEMPLATES = {
  'probe-ports': {
    need: 'port',
    code: `#!/usr/bin/env node
// 端口体检小工具（主脑按需生成）：node tools/gen/probe-ports.mjs
import net from 'node:net';

const PORTS = [3000, 3001, 3100, 7788];
const open = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
  s.setTimeout(1500, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

for (const p of PORTS) console.log(p, (await open(p)) ? 'OK' : 'DOWN');
`,
  },
  'trim-logs': {
    need: 'log',
    code: `#!/usr/bin/env node
// 日志裁剪小工具（主脑按需生成）：node tools/gen/trim-logs.mjs [目录] [行数]
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || path.join(import.meta.dirname, '..', '..', 'state');
const keep = Number(process.argv[3] || 800);
let n = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.log'))) {
  const p = path.join(dir, f);
  try {
    const sz = fs.statSync(p).size;
    if (sz < 4 * 1024 * 1024) continue;
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split('\\n').slice(-keep).join('\\n'));
    n += 1;
    console.log('trimmed', f, Math.round(sz / 1048576) + 'MB');
  } catch {}
}
if (!n) console.log('no big log');
`,
  },
  'dump-status': {
    need: 'status',
    code: `#!/usr/bin/env node
// 一键抓状态（主脑按需生成）：node tools/gen/dump-status.mjs > status.txt
import fs from 'node:fs';
import path from 'node:path';

const state = process.argv[2] || path.join(import.meta.dirname, '..', '..', 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'state');
for (const f of ['brain.json', 'mouth-report.json', 'eye.json', 'medic.json', 'heal-library.json', 'heal-queue.json']) {
  const p = path.join(state, f);
  try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); console.log('== ' + f); console.log(JSON.stringify(j, null, 2).slice(0, 4000)); } catch { console.log('== ' + f + ' (missing)'); }
}
`,
  },
};

export function creationPlan(ctx) {
  const root = ctx.root || '';
  const stateDir = ctx.stateDir || '';
  const decisions = ctx.decisions || [];
  const created = readJson(path.join(stateDir, CREATED)) || { items: [] };
  const made = new Set(created.items.map((x) => x.name));

  // 需求计数：同一类问题在最近 200 条决策里出现 3 次以上
  const counts = { port: 0, log: 0, status: 0 };
  for (const d of decisions.slice(-200)) {
    const s = `${d.rule} ${d.action} ${d.detail || ''}`;
    if (/端口|:3100|:3000|bridge|napcat/i.test(s)) counts.port += 1;
    if (/日志|log/i.test(s)) counts.log += 1;
    if (/状态|status|嘴报/i.test(s)) counts.status += 1;
  }

  const proposals = [];
  for (const [name, t] of Object.entries(TEMPLATES)) {
    if (made.has(name)) continue;
    if ((counts[t.need] || 0) < 3) continue;
    const rel = path.join('tools', 'gen', name + '.mjs');
    if (exists(path.join(root, rel))) continue; // 绝不覆盖
    proposals.push({
      kind: 'create-helper',
      why: `「${t.need}」类问题出现了 ${counts[t.need]} 次，造个小工具`,
      name,
      rel,
      code: t.code,
    });
  }
  return { proposals, notes: [] };
}

export function recordCreated(stateDir, name, rel, why) {
  const file = path.join(stateDir, CREATED);
  const cur = readJson(file) || { items: [] };
  cur.items.push({ at: new Date().toISOString(), name, rel, why });
  cur.items = cur.items.slice(-100);
  writeJson(file, cur);
}

// ── 喜悦：连续正常一周，就奖励一次 ─────────────────────────────────

const REWARD_MS = 7 * DAY;
const REWARD_LEN_MS = DAY;

export function joyPlan(ctx) {
  const stateDir = ctx.stateDir || '';
  const now = ctx.now || Date.now();
  const healthy = ctx.healthy || [];   // [{ role, healthy:true }]
  const file = path.join(stateDir, JOY);
  const st = readJson(file) || { organs: {} };
  const proposals = [];

  for (const h of healthy) {
    const cur = st.organs[h.role] || { since: now, lastRewardAt: 0 };
    // since / lastRewardAt 既可能是毫秒数，也可能是 ISO 字符串（手写和历史文件两种都出现过）
    const sinceMs = typeof cur.since === 'number' ? cur.since : (Date.parse(cur.since) || now);
    cur.since = sinceMs;
    const rewardAt = typeof cur.lastRewardAt === 'number' ? cur.lastRewardAt : (Date.parse(cur.lastRewardAt) || 0);
    st.organs[h.role] = cur;
    const span = now - sinceMs;
    if (span >= REWARD_MS && now - rewardAt >= REWARD_MS) {
      cur.lastRewardAt = now;
      cur.streakFrom = cur.since;
      cur.since = now;
      proposals.push({
        kind: 'reward-organ',
        why: `连续 ${Math.round(span / DAY)} 天没出问题`,
        organ: h.role,
        until: now + REWARD_LEN_MS,
      });
    }
  }
  writeJson(file, st);
  return { proposals, notes: [] };
}

export function recordReward(stateDir, organ, why, until) {
  const file = path.join(stateDir, JOY);
  const st = readJson(file) || { organs: {} };
  st.rewards = (st.rewards || []).concat([{ at: new Date().toISOString(), organ, why, until }]).slice(-100);
  writeJson(file, st);
}
