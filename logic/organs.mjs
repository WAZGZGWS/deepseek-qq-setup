/**
 * logic/organs.mjs —— 主脑的理性：给「死掉的器官/没用的脚本」办退役 + 记病因。
 *
 * 创造逻辑和喜悦逻辑已经删掉：前者几乎不触发，后者只是仪式，都不护她。
 * 留下来的只有一件真正有用的事：谁没用了，搬进 trash（可捞回），病因写进 autopsy.json。
 */

export const INFO = { name: '理性', role: '退役与尸检', version: 2 };

import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400000;
const AUTOPSEY = 'autopsy.json';

const LEGACY = [
  { rel: 'stack-guard/stack-guard.mjs', why: '守夜人已被急救员取代（急救员独立于主脑）' },
  { rel: 'supervisor/supervisor.mjs', why: 'supervisor 已被主脑取代（主脑占着它的角色锁）' },
];

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, v) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); } catch {} }
function age(p) { try { return Date.now() - fs.statSync(p).mtimeMs; } catch { return 0; } }

function referenced(root, name) {
  const roots = ['', 'supervisor', 'tools', 'stack-doctor', 'medic', 'eye', 'mouth', 'hemis', 'hands', 'logic', 'blackbox', 'vitals', 'treasurer', 'hippocampus', 'ears', 'world', 'clock', 'install.ps1'];
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
      if (p.includes('logic')) return;
      if (fs.readFileSync(p, 'utf8').includes(name)) hits += 1;
    } catch {}
  };
  for (const d of roots) scan(d ? path.join(root, d) : root);
  return hits > 0;
}

export function rationalPlan(ctx) {
  const root = ctx.root || '';
  const items = [];
  const notes = [];
  for (const l of LEGACY) {
    const abs = path.join(root, l.rel);
    if (!exists(abs)) continue;
    if (referenced(root, path.basename(l.rel))) { notes.push(l.rel + ' 还被引用，先不动'); continue; }
    items.push({ rel: l.rel, why: l.why });
  }
  const oneoff = path.join(root, 'archive', 'oneoff');
  if (exists(oneoff)) {
    for (const f of fs.readdirSync(oneoff)) {
      const abs = path.join(oneoff, f);
      if (!/\.(py|mjs|js|cmd|ps1)$/i.test(f)) continue;
      if (age(abs) < 21 * DAY) continue;
      items.push({ rel: path.join('archive', 'oneoff', f), why: '一次性脚本，21 天没动过' });
    }
  }
  if (!items.length) return { proposals: [], notes };
  return {
    proposals: [{
      kind: 'trash-legacy',
      why: items.length + ' 个已死/无用脚本（搬到 trash，可捞回来）',
      items: items.map((x) => ({ rel: x.rel, why: x.why, size: 0 })),
      autopsy: items.map((x) => ({ at: new Date().toISOString(), rel: x.rel, cause: x.why, verdict: '退役' })),
    }],
    notes,
  };
}

export function recordAutopsy(stateDir, records) {
  if (!records || !records.length) return 0;
  const file = path.join(stateDir, AUTOPSEY);
  const cur = readJson(file) || { items: [] };
  for (const r of records) cur.items.push(r);
  cur.items = cur.items.slice(-200);
  writeJson(file, cur);
  return records.length;
}
