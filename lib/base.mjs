/**
 * lib/base.mjs —— 全项目共用的那几样东西
 *
 * 为什么有它：这 20 多个脚本原来各自抄一遍「路径 4 行 + 时间戳 + console-token +
 * 主人 QQ」，抄得还不完全一样——时间戳有的带时区有的不带，取 QQ 的写法有 6 种。
 * 这类东西一旦漂移，日志对不上、请求发错人，很难查。
 *
 * 现在统一在这里：改一次，全项目跟着改。
 *
 * 规矩：本文件不许 import 项目里别的文件（防止循环依赖），只用 Node 内置模块。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 路径 ──────────────────────────────────────────────────────────────
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/** 部署根目录（本文件在 <根>/lib/ 下，所以往上退一层） */
export const ROOT = path.join(HERE, '..');
/** 桥接目录 */
export const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');
/** 桥接的运行状态目录（锁、日志、记忆都在这儿） */
export const STATE = path.join(BRIDGE, 'state');

/**
 * 取调用方脚本自己所在的目录。
 * HERE 每个文件都不一样，没法共用，所以给个函数：`const HERE = dirOf(import.meta.url)`。
 * 传字符串（'file:///E:/...'）或 URL 对象都行。
 */
export function dirOf(metaUrl) {
  return path.dirname(fileURLToPath(metaUrl));
}

// ── 时间 ──────────────────────────────────────────────────────────────
/** 日志前缀：`2026/10/28 09:41:58`（一律北京时间，机器时区是什么都不管） */
export function stamp() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

/** 今天几号：`2026-10-28`。跨天判断全用它，别用 toISOString（那是 UTC，晚上 8 点就跨天了） */
export function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

// ── 读文件 ────────────────────────────────────────────────────────────
/** 读 JSON，读不到/坏了就给兜底值，不抛异常 */
export function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ── 身份：主人 QQ / 会话 key ──────────────────────────────────────────
/** 主人的 QQ 号：从桥接 config.json 读，0 表示没配 */
export function ownerQQ(bridgeDir = BRIDGE) {
  const n = Number(readJson(path.join(bridgeDir, 'config.json'), {}).ownerQQ);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 会话 key：`private:<主人QQ>`。
 * 环境变量 CHAT_KEY 优先（多开/测试用），否则跟 config.json 走 —— 下载的人不用手改。
 */
export function chatKey(bridgeDir = BRIDGE) {
  if (process.env.CHAT_KEY) return process.env.CHAT_KEY;
  const q = ownerQQ(bridgeDir);
  return q ? `private:${q}` : 'private:YOUR_QQ';
}

// ── 桥接控制台 ────────────────────────────────────────────────────────
/** 控制台令牌，桥接启动时写在 state/console-token */
export function consoleToken() {
  return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
}

/** 调桥接控制台：consoleApi('/api/silence', { method: 'POST', body: ... }) */
export async function consoleApi(pathname, options = {}) {
  const r = await fetch(`http://127.0.0.1:3100${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-console-token': consoleToken() },
    signal: AbortSignal.timeout(20000),
  });
  // 控制台的接口有的回 JSON、有的回一句纯文本，能解析就给你对象，解析不了给原文
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}

// ── 端口 ──────────────────────────────────────────────────────────────
/** 端口通不通（只连一下就走，2 秒超时） */
export function portOpen(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => {
      try { s.destroy(); } catch {}
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// ── DeepSeek 计价（元 / 百万 token） ──────────────────────────────────
/** 官方价：缓存命中 0.2、未命中 2.0、输出 8.0。涨价了只改这一处 */
export const PRICE = { cacheHit: 0.2, cacheMiss: 2.0, output: 8.0 };

/** 把 token-usage.jsonl 里一条的 b 字段折算成人民币 */
export function costOf(b = {}) {
  return (
    ((b.cacheHit || 0) / 1e6) * PRICE.cacheHit +
    ((b.cacheMiss || 0) / 1e6) * PRICE.cacheMiss +
    ((b.output || 0) / 1e6) * PRICE.output
  );
}
