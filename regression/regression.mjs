#!/usr/bin/env node
/**
 * regression —— 改完人设/配置后的自检（不需要管理员、不花 token）
 *
 * 检查：角色卡关键小节、预设纪律、关键配置、工具数量、qzone 护栏、
 *       自启项、端口、记忆非空、今天的聊天档案。
 *
 * 用法：node regression.mjs
 * 退出码：0 全过；1 有失败项
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');
const STARTUP = path.join(process.env.APPDATA || '', 'Microsoft/Windows/Start Menu/Programs/Startup');

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push({ name, ok: r === true || r === undefined, detail: typeof r === 'string' ? r : '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}
function read(file) {
  return fs.readFileSync(file, 'utf8');
}
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(1200, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// ---- 角色卡 ----
const roleFile = path.join(BRIDGE, 'roles', '<BOT_NAME>.md');
check('角色卡存在', () => fs.existsSync(roleFile) || '缺失 roles/<BOT_NAME>.md');
check('角色卡有「你是谁」', () => read(roleFile).includes('你是谁'));
check('角色卡有「口癖」', () => read(roleFile).includes('口癖'));
check('角色卡有「翻旧账」', () => read(roleFile).includes('翻旧账'));
check('角色卡长度 1500~8000 字', () => {
  // 精简过一轮（6230 → 2202），下限改成 1500：再短就该怀疑是不是被误删了
  const n = read(roleFile).length;
  return (n >= 1500 && n <= 8000) || `当前 ${n}`;
});

// ---- 预设 ----
const preset = path.join(BRIDGE, 'plugins', 'qq-agent-presets', 'presets', 'qq-chat-v2.patch.yml');
check('预设 patch 存在', () => fs.existsSync(preset) || '缺失');
check('预设含省钱纪律', () => read(preset).includes('省钱纪律'));
check('预设含自发性', () => read(preset).includes('自发性'));
check('预设含自定时间', () => read(preset).includes('什么时候醒'));

// ---- 配置 ----
const cfg = JSON.parse(read(path.join(BRIDGE, 'config.json')));
check('白名单只有哥', () => JSON.stringify(cfg.allow.private) === '["YOUR_QQ"]' || JSON.stringify(cfg.allow.private));
check('allowAllWhenEmpty=false', () => cfg.allowAllWhenEmpty === false);
check('群聊未开放', () => (cfg.allow.groups || []).length === 0);
check('系统提示静默', () => cfg.systemNotices === false);
check('排队提示静默', () => cfg.noticeOnQueue === false);
check('唤醒不限流', () => cfg.socialV2.wake.maxWakePerHour === 0 && cfg.socialV2.wake.maxWakePerMinute === 0);
check('工具数 <= 15', () => {
  const n = Object.entries(cfg.socialV2.tools).filter(([, v]) => v).length;
  return n <= 15 || `当前 ${n}`;
});
// 2026-10-27 起改成「允许偶尔主动开口」：不再要求全关，而是要求开得克制。
// 概率 > 0.3 就太吵了（一天能主动找你七八次），间隔 < 10 分钟也算失控。
check('主动唤醒克制', () => {
  const p = cfg.socialV2.proactive || {};
  if (p.enabled === false) return true; // 关掉当然也算克制
  const prob = Number(p.probability);
  const minMs = Number(p.checkIntervalMinMs);
  const bad = [];
  if (!(prob <= 0.3)) bad.push(`概率 ${prob}`);
  if (!(minMs >= 10 * 60 * 1000)) bad.push(`间隔 ${Math.round(minMs / 60000)}min`);
  return bad.length === 0 || bad.join(' / ');
});

// ---- qzone 护栏 ----
const qz = read(path.join(BRIDGE, 'src', 'mcp-qzone.mjs'));
check('说说上限 2 条/天', () => qz.includes('QZONE_DAILY_CAP || 2'));
check('说说间隔 4 小时', () => qz.includes('4 * 60 * 60 * 1000'));
check('点赞上限 1 次/天', () => qz.includes('const LIKE_CAP = 1;'));

// ---- 自启项 ----
const startupFiles = fs.existsSync(STARTUP) ? fs.readdirSync(STARTUP).filter((n) => n.startsWith('qqbot-')) : [];
check('自启项 >= 2（其余由计划任务/supervisor 负责）', () => startupFiles.length >= 2 || `当前 ${startupFiles.length}`);

// ---- 记忆 ----
let memoryOk = false;
try {
  const token = read(path.join(BRIDGE, 'state', 'console-token')).trim();
  const res = await fetch('http://127.0.0.1:3100/api/socialV2/memory?key=' + encodeURIComponent(cfg.ownerQQ ? `private:${cfg.ownerQQ}` : 'private:YOUR_QQ'), { headers: { 'x-console-token': token } });
  const j = await res.json();
  const raw = j.raw || {};
  const n = (raw.activeTopics || []).length + Object.keys(raw.memberImpressions || {}).length;
  memoryOk = n > 0;
  check('记忆非空', () => memoryOk || `话题+印象 = ${n}`);
} catch (e) {
  check('记忆非空', () => `读取失败：${e.message}`);
}

// ---- 档案 ----
const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const archiveFile = path.join(ROOT, 'archive', 'logs', `${day}.md`);
check('今天有聊天档案', () => fs.existsSync(archiveFile) || '尚未生成（今天还没聊天）');

// ---- 端口 ----
const p3000 = await portOpen(3000);
const p3001 = await portOpen(3001);
const p3100 = await portOpen(3100);
check('NapCat 3000', () => p3000 || '未监听');
check('NapCat 3001', () => p3001 || '未监听');
check('桥接控制台 3100', () => p3100 || '未监听');

// ---- 输出 ----
let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
