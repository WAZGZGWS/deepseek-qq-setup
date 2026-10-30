#!/usr/bin/env node
/**
 * organ-mode —— 给器官授权 / 收回授权（默认只读）。
 *
 * 用法：
 *   node tools/organ-mode.mjs                看当前模式
 *   node tools/organ-mode.mjs ears active    允许耳朵执行邮件指令
 *   node tools/organ-mode.mjs ears readonly  收回（只记录、不动手）
 */
import { STATE, stamp } from '../lib/base.mjs';
import { listModes, setMode } from '../lib/organ-policy.mjs';

const [name, mode] = process.argv.slice(2);
if (!name) {
  for (const r of listModes(STATE)) console.log((r.mode === 'active' ? '[active ] ' : '[readonly] ') + r.name);
  process.exit(0);
}
const m = setMode(STATE, name, mode === 'active' ? 'active' : 'readonly');
console.log(`[${stamp()}] ${name} → ${m}`);
