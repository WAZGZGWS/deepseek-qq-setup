#!/usr/bin/env node
/**
 * 静态自查：找「调用了但没定义/没导入」的本地函数 —— 就是今天 today() 那类坑。
 *
 * 不是完整 linter，但足够抓「改名后漏改一处」「从别的文件抄过来少个 helper」这类问题。
 * 只看裸函数调用（name(），跳过 obj.name(）、关键字、已知全局。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/1/qq-stack';
const SKIP = new Set(['node_modules', 'napcat', 'backups', 'versions', 'archive', 'state', 'chat-memory', 'logs', 'reports', '.git', 'dsh-qq']);

const GLOBALS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new', 'delete', 'void', 'await', 'async',
  'console', 'process', 'require', 'module', 'exports', 'globalThis',
  'JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'Symbol', 'BigInt', 'Intl', 'URL', 'URLSearchParams', 'Buffer',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask', 'structuredClone',
  'fetch', 'Request', 'Response', 'Headers', 'FormData', 'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'atob', 'btoa', 'crypto', 'performance', 'opener', 'navigator', 'window', 'document', 'localStorage',
  'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach',
]);

function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(path.join(dir, e.name), out);
      continue;
    }
    if (/\.(mjs|js)$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

function analyze(file) {
  const text = fs.readFileSync(file, 'utf8');
  // 定义：function foo / const foo = / let foo = / class Foo / import { a as b } / destructure
  const defined = new Set();
  for (const m of text.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
  for (const m of text.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of text.matchAll(/import\s+([^;]+?)\s+from/g)) {
    const clause = m[1].replace(/[{}]/g, ' ');
    for (const part of clause.split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const as = piece.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      defined.add(as ? as[1] : piece.replace(/^\*\s+as\s+/, '').trim());
    }
  }
  for (const m of text.matchAll(/const\s*\{([^}]+)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim();
      if (name) defined.add(name);
    }
  }
  // 调用：前面不是 . 也不是 ->，排除 new X( 之外的属性访问
  const calls = new Map();
  for (const m of text.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (GLOBALS.has(name) || defined.has(name)) continue;
    if (m[1] === '.' ) continue;
    const idx = m.index + m[0].length;
    const line = text.slice(0, idx).split('\n').length;
    if (!calls.has(name)) calls.set(name, line);
  }
  return calls;
}

const files = walk(ROOT);
let total = 0;
for (const f of files.sort()) {
  const calls = analyze(f);
  if (!calls.size) continue;
  total += calls.size;
  console.log(`\n${path.relative(ROOT, f)}`);
  for (const [name, line] of calls) console.log(`  行 ${line}: ${name}( )  ← 可能是未定义`);
}
console.log(`\n共 ${files.length} 个文件，可疑 ${total} 处`);
