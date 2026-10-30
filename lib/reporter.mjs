/**
 * lib/reporter.mjs —— 汇报（原「嘴」的活，并进眼）。
 *
 * 眼负责看，顺手把「谁死了、谁摸鱼、能不能干活」汇总成一份报告给主脑。
 * 以前这是独立器官「嘴」的活，现在同一个进程里做：少一个进程、少一套锁和状态。
 *
 * 只写文件，不动手。
 */
import fs from 'node:fs';
import path from 'node:path';

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function readPid(p) { try { return Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch { return 0; } }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function eyeFindings(stateDir) {
  try {
    const j = readJson(path.join(stateDir, 'eye-findings.json'));
    return Array.isArray(j?.findings) ? j.findings.map((x) => x.code + ':' + (x.why || x.what || '')) : [];
  } catch { return []; }
}

/** 汇总一份给主脑看的报告（state/eye-report.json；主脑读的就是这个） */
export function report(stateDir, now = Date.now()) {
  const brainPid = readPid(path.join(stateDir, 'brain.lock'));
  const bj = readJson(path.join(stateDir, 'brain.json')) || {};
  const brainAge = bj.at ? now - Date.parse(bj.at) : -1;
  const brainAlive = pidAlive(brainPid) && brainAge >= 0 && brainAge < 150000;

  const dead = [];
  const idle = [];
  const who = {};

  who.brain = { alive: brainAlive, pid: brainPid, ageSec: brainAge < 0 ? null : Math.round(brainAge / 1000) };
  if (!brainAlive) dead.push('brain');

  const h = bj.hemis || {};
  for (const name of ['left', 'right', 'cerebellum']) {
    const s = h[name] || {};
    who[name] = { status: s.status || 'unknown', offlineSec: s.offlineSec || 0, errors: s.errors || 0, violations: s.violations || 0 };
    if (!brainAlive) dead.push(name);
    else if (s.status === 'offline') {
      dead.push(name);
      if ((s.offlineSec || 0) > 600) idle.push(`${name} 下线超过 10 分钟`);
    }
  }

  for (const name of ['eye', 'medic', 'blackbox', 'vitals', 'treasurer', 'hippocampus', 'ears', 'world', 'clock']) {
    let pid = 0;
    try { pid = Number(fs.readFileSync(path.join(stateDir, `${name}.lock`), 'utf8').trim()) || 0; } catch {}
    const alive = pidAlive(pid);
    who[name] = { alive, pid };
    if (!alive && name !== 'eye') dead.push(name);
  }

  const ws = Array.isArray(bj.workers) ? bj.workers : [];
  const running = ws.filter((w) => w.alive).length;
  const stale = ws.filter((w) => w.alive && w.lockAgeSec > 180).map((w) => w.name);
  const quarantined = ws.filter((w) => w.quarantineSec > 0).map((w) => w.name);
  who.workers = { running, total: ws.length, stale, quarantined };
  for (const n of stale) idle.push(`worker ${n} 锁僵住`);
  for (const n of quarantined) idle.push(`worker ${n} 在隔离`);

  const eyeSaw = eyeFindings(stateDir);
  const eyeTail = eyeSaw.length ? `，眼看到 ${eyeSaw.length} 条` : '';
  const data = {
    at: new Date(now).toISOString(),
    canWork: brainAlive && running > 0,
    dead,
    idle,
    workers: who.workers,
    hemis: { left: who.left, right: who.right, cerebellum: who.cerebellum },
    organs: Object.fromEntries(Object.entries(who).filter(([k]) => !['brain', 'left', 'right', 'cerebellum', 'workers'].includes(k))),
    eyeSaw,
    summary: `主脑${brainAlive ? '在' : '不在'}，worker ${running}/${ws.length} 能干活，死：${dead.length ? dead.join('/') : '无'}，摸鱼：${idle.length ? idle.join('/') : '无'}${eyeTail}`,
  };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'eye-report.json'), JSON.stringify(data, null, 2));
  } catch {}
  return data;
}
