/**
 * lib/organ-policy.mjs —— 器官默认「只读」。
 *
 * 教训：今天三个器官都干过「自作主张」的事（急救员把桥接当 worker 杀了、耳朵自测真的改了省钱策略、
 * 镜子把她的话当成他的偏好）。所以定规矩：**新器官默认只读**，想动手必须先被登记成 active。
 *
 * 只读的器官照样观察、照样写自己的报告，只是在要「改别人的东西」时停一下：
 * 删记忆、发邮件、改桥接配置、重启进程 —— 这类动作统一走 isActive() 判断。
 *
 * 对谁 active 写在 state/organ-policy.json，默认列表见下；改它用 tools/organ-mode.mjs。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 一开始就信任的（它们只碰自己的东西，或者本来就是救命通道） */
const DEFAULT_ACTIVE = ['eye', 'medic', 'blackbox', 'vitals', 'world', 'clock'];

export function policyFile(stateDir) { return path.join(stateDir, 'organ-policy.json'); }

export function readPolicy(stateDir) {
  try { return JSON.parse(fs.readFileSync(policyFile(stateDir), 'utf8')); } catch { return {}; }
}

export function isActive(stateDir, name) {
  const p = readPolicy(stateDir);
  if (p && p[name] === 'active') return true;
  if (p && p[name] === 'readonly') return false;
  return DEFAULT_ACTIVE.includes(name);
}

export function setMode(stateDir, name, mode) {
  const p = readPolicy(stateDir);
  p[name] = mode === 'active' ? 'active' : 'readonly';
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(policyFile(stateDir), JSON.stringify(p, null, 2));
  return p[name];
}

export function listModes(stateDir) {
  const p = readPolicy(stateDir);
  const names = new Set([...DEFAULT_ACTIVE, ...Object.keys(p)]);
  return [...names].sort().map((n) => ({ name: n, mode: p[n] || (DEFAULT_ACTIVE.includes(n) ? 'active' : 'readonly') }));
}
