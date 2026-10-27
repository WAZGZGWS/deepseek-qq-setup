#!/usr/bin/env node
/**
 * notify —— 统一外部告警出口（电脑出事时通知到你手机）
 *
 * 配置：<STACK_ROOT>\notify.json
 *   { "type": "json" | "bark" | "dingtalk", "webhook": "https://...", "enabled": true }
 *
 * 没配 webhook 时不会丢消息：写进 state/notify-pending.log，等你配置后可以补发。
 * 用法：node notify.mjs "要发的内容"
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');
const STATE = path.join(BRIDGE, 'state');
const CONF = path.join(ROOT, 'notify.json');

const text = process.argv.slice(2).join(' ') || '(empty)';

function loadConf() {
  try {
    return JSON.parse(fs.readFileSync(CONF, 'utf8'));
  } catch {
    return { type: 'json', webhook: '', enabled: true };
  }
}

function queue(msg) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(path.join(STATE, 'notify-pending.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export async function notify(msg) {
  const conf = loadConf();
  if (conf.enabled === false || !conf.webhook) {
    queue(msg);
    console.log('[notify] 未配置 webhook，已排队到 state/notify-pending.log');
    return false;
  }
  let body;
  if (conf.type === 'bark') {
    body = { title: 'QQ Bot', body: msg };
  } else if (conf.type === 'dingtalk') {
    body = { msgtype: 'text', text: { content: msg } };
  } else {
    body = { text: msg, content: msg, message: msg };
  }
  try {
    const r = await fetch(conf.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    console.log('[notify]', r.status);
    return r.ok;
  } catch (e) {
    console.log('[notify] 失败:', e.message);
    queue(msg);
    return false;
  }
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  await notify(text);
}
