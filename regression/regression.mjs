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
import { spawnSync } from 'node:child_process';
import { ROOT, BRIDGE, portOpen, chatKey } from '../lib/base.mjs';
import { DEBT_MAX_CHARS, debtParse, isDebt } from '../lib/memory-rules.mjs';

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

// ---- 角色卡 ----
// 不写死人设文件名：开源用户爱叫什么叫什么，我们自己的名字也已经脱敏。
function findRoleFile() {
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(BRIDGE, 'state', 'current-role.json'), 'utf8'));
    const name = String(cur?.name || cur?.role || '').trim();
    if (name) {
      const p1 = path.join(BRIDGE, 'roles', name.endsWith('.md') ? name : name + '.md');
      if (fs.existsSync(p1)) return p1;
    }
  } catch {}
  try {
    const dir = path.join(BRIDGE, 'roles');
    const f = fs.readdirSync(dir).filter((x) => x.endsWith('.md') && x.toLowerCase() !== 'readme.md')[0];
    if (f) return path.join(dir, f);
  } catch {}
  return path.join(BRIDGE, 'roles', 'role.md');
}
const roleFile = findRoleFile();
check('角色卡存在', () => fs.existsSync(roleFile) || ('roles/ 下没有角色卡（找的是 ' + path.basename(roleFile) + '）'));
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
check('白名单只有一个联系人', () => (cfg.allow.private || []).length === 1 || ('当前 ' + JSON.stringify(cfg.allow.private)));
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
let memRaw = {};
try {
  const token = read(path.join(BRIDGE, 'state', 'console-token')).trim();
  const res = await fetch('http://127.0.0.1:3100/api/socialV2/memory?key=' + encodeURIComponent(chatKey()), { headers: { 'x-console-token': token } });
  const j = await res.json();
  const raw = j.raw || {};
  memRaw = raw;
  const n = (raw.activeTopics || []).length + Object.keys(raw.memberImpressions || {}).length;
  memoryOk = n > 0;
  check('记忆非空', () => memoryOk || `话题+印象 = ${n}`);
} catch (e) {
  check('记忆非空', () => `读取失败：${e.message}`);
}

// ---- 欠账本（2026-10-29）----
// 起因：鸭腿债在记忆里被摘要压成「十根…两只…打五折」一坨，谁也说不清欠多少。
// 现在欠账走固定格式 fact，规则一份、tidy 不许压、唤醒单独注入。四道都要在位。
check('欠账规则一份（memory-rules）', () => {
  const r = read(path.join(ROOT, 'lib', 'memory-rules.mjs'));
  return (r.includes('export function isDebt') && r.includes('export function debtParse') && r.includes('export function fitDebt')) || 'memory-rules 里缺欠账解析函数';
});
check('memory-tidy 不许压账本', () => {
  const t = read(path.join(ROOT, 'memory-tidy', 'memory-tidy.mjs'));
  const ok = /isDebt|fitDebt/.test(t) && t.includes('DEBT_BUDGET');
  return ok || 'tidy 没接欠账保护：账目会被模型压短或并掉，等于替她赖账';
});
check('唤醒提示里有【欠账】段', () => {
  const b = read(path.join(BRIDGE, 'src', 'bridge.js'));
  return b.includes('【欠账') || 'bridge.js 里没有欠账段：账本记了也翻不到';
});
check('预设教了欠账格式', () => {
  const p = read(preset);
  return (p.includes('欠账｜') && p.includes('欠账记法')) || '预设里没写「欠账｜内容×数量｜日期」，她不会按格式记';
});
check('记忆里的欠账能对账', () => {
  const facts = (memRaw.facts || []).map((f) => (typeof f === 'string' ? f : f && f.text)).filter(Boolean).map(String);
  const ds = facts.filter(isDebt);
  const bad = ds.filter((t) => !debtParse(t) || t.length > DEBT_MAX_CHARS);
  return bad.length === 0 || `有 ${bad.length} 条欠账格式坏了：${bad.slice(0, 2).join('；')}`;
});
check('账本规则自测通过（tidy --selftest）', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'memory-tidy', 'memory-tidy.mjs'), '--selftest'], { encoding: 'utf8', timeout: 60000 });
  if (r.status === 0) return true;
  const bad = String(r.stdout || '').split('\n').filter((l) => l.includes('✗')).join('；');
  return '自测失败：' + (bad || r.stderr || '未知原因');
});

// ---- 档案 ----
const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const archiveFile = path.join(ROOT, 'archive', 'logs', `${day}.md`);
check('今天有聊天档案', () => fs.existsSync(archiveFile) || '尚未生成（今天还没聊天）');

// ---- 端口 ----
const p3000 = await portOpen(3000);

// NapCat 是否"真"在响应：这版对不认识的请求会回
// {"status":"ok","data":{},"message":"NapCat4 Is Running"} —— 只看 status 会被骗。
let napcatReal = false;
if (p3000) {
  try {
    const r = await fetch('http://127.0.0.1:3000/get_login_info', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    napcatReal = !!j?.data?.user_id && !String(j?.message || '').includes('NapCat4 Is Running');
  } catch {}
}
const p3001 = await portOpen(3001);
const p3100 = await portOpen(3100);
check('NapCat 3000', () => p3000 || '未监听');
check('NapCat 3001', () => p3001 || '未监听');
check('NapCat 接口真在响应（不是假 ok）', () => napcatReal || '收到假 ok 或没返回 user_id');

check('桥接控制台 3100', () => p3100 || '未监听');

// ---- 新组件在位（2026-10-27/28 加的）----
check('stack-doctor 存在', () => fs.existsSync(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs')));
check('like-card 存在', () => fs.existsSync(path.join(ROOT, 'like-card', 'like-card.mjs')));
check('eye-drop 存在', () => fs.existsSync(path.join(ROOT, 'eye-drop', 'eye-drop.mjs')));
check('eye-drop 已注册进 supervisor', () => {
  // 名单在 supervisor/workers.mjs（supervisor 和 stack-doctor 共用这份）
  const s = fs.readFileSync(path.join(ROOT, 'supervisor', 'workers.mjs'), 'utf8');
  return /name:\s*'eye-drop'/.test(s) || 'workers.mjs 里没注册，它不会自己起来';
});
check('stack-doctor 用同一份工人名单', () => {
  const s = fs.readFileSync(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs'), 'utf8');
  return /from '\.\.\/supervisor\/workers\.mjs'/.test(s) || 'stack-doctor 又自己写了一份名单，早晚和 supervisor 对不上';
});
check('滴眼药水改为按醒来时间排（固定任务应已停用）', () => {
  const f = path.join(BRIDGE, 'state', 'scheduler.json');
  if (!fs.existsSync(f)) return '读不到 scheduler.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const fixed = (j.tasks || []).filter((t) => /^滴眼药水/.test(t.name) && t.enabled !== false);
  return fixed.length === 0 || `还有 ${fixed.length} 条固定任务开着（会和 eye-drop 重复提醒）`;
});

// ---- 计划任务不许弹黑框（2026-10-29：每 2 分钟的体检任务在屏幕上闪一下）----
check('隐藏启动器在位（run-hidden.vbs）', () => fs.existsSync(path.join(ROOT, 'run-hidden.vbs')) || '缺 run-hidden.vbs，计划任务只能退回 cmd（会闪黑框）');
check('计划任务用静默启动', () => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-ScheduledTask -TaskName 'QQStackDoctor' -ErrorAction SilentlyContinue).Actions | ForEach-Object { \"$($_.Execute) $($_.Arguments)\" }",
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const line = String(r.stdout || '').trim();
  if (!line) return true; // 没注册（比如非管理员装的）不算这次的错
  return line.includes('run-hidden.vbs') || `动作还是「${line}」——每 2 分钟会闪一个 cmd 黑框`;
});

check('保持唤醒有自愈（巡检判活 + 心跳）', () => {
  const d = read(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs'));
  const s = read(path.join(ROOT, '4-hold-awake.ps1'));
  const okD = d.includes('keep-awake.heartbeat') && d.includes("handle(state, 'keepAwake'");
  const okS = s.includes('keep-awake.heartbeat');
  return (okD && okS) || '2026-10-29 的坑：保持唤醒进程死了没人管，合盖就睡、QQ 掉线 10 小时';
});
check('短信验证会自动等人（后台轮询 + 链接落盘）', () => {
  const s = read(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs'));
  const ok = s.includes('qq-verify-link.txt') && s.includes('VERIFY_WAIT_SEC') && s.includes('startVerifyPoller');
  return ok || '2026-10-29 的坑：验证链接跟当次请求绑定，脚本退出就作废；没有后台轮询等于点一次白一次';
});
// ---- 公共件不许再被抄回去（2026-10-28 收过一次重复）----
check('公共件存在（lib/base.mjs）', () => fs.existsSync(path.join(ROOT, 'lib', 'base.mjs')));
check('没有脚本再抄一份路径样板', () => {
  const bad = [];
  for (const ent of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name === 'lib' || ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const dir = path.join(ROOT, ent.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.mjs')) continue;
      const t = fs.readFileSync(path.join(dir, f), 'utf8');
      if (/new URL\(import\.meta\.url\)\.pathname/.test(t)) bad.push(`${ent.name}/${f}`);
    }
  }
  return bad.length === 0 || `又抄回去了：${bad.join(', ')}（应该 import lib/base.mjs）`;
});

// ---- 记忆规则只许有一份（memory-tidy 清、self-check 查，必须同一套）----
check('记忆规则只有一份（lib/memory-rules.mjs）', () => {
  const p = path.join(ROOT, 'lib', 'memory-rules.mjs');
  if (!fs.existsSync(p)) return '缺 lib/memory-rules.mjs';
  const tidy = fs.readFileSync(path.join(ROOT, 'memory-tidy', 'memory-tidy.mjs'), 'utf8');
  const self = fs.readFileSync(path.join(ROOT, 'self-check', 'self-check.mjs'), 'utf8');
  const bad = [];
  if (!tidy.includes("from '../lib/memory-rules.mjs'")) bad.push('memory-tidy 没用公共规则');
  if (!self.includes("from '../lib/memory-rules.mjs'")) bad.push('self-check 没用公共规则');
  if (/function junkReason\(/.test(tidy + self)) bad.push('有人又抄了一份 junkReason');
  return bad.length === 0 || bad.join('；');
});
check('会话和附件会自动清（省空间）', () => {
  const s = fs.readFileSync(path.join(ROOT, 'session-janitor', 'session-janitor.mjs'), 'utf8');
  const ok = /SESSION_KEEP_DAYS/.test(s) && /ATTACH_KEEP_DAYS/.test(s) && /pruneOld\(/.test(s);
  return ok || 'session-janitor 里没有保留天数/清理逻辑';
});
check('免扫码登录工具在位', () => {
  const login = path.join(ROOT, 'tools', 'qq-login.mjs');
  const setter = path.join(ROOT, 'tools', 'set-qq-password.ps1');
  if (!fs.existsSync(login)) return '缺 tools/qq-login.mjs';
  if (!fs.existsSync(setter)) return '缺 tools/set-qq-password.ps1';
  const t = fs.readFileSync(login, 'utf8');
  if (!t.includes('ProtectedData')) return '密码没有用 DPAPI 加密';
  if (/password\s*:\s*['"][^'"]+['"]/.test(t)) return '脚本里疑似写死了密码';
  return true;
});
check('带中文的 .ps1 必须有 UTF-8 BOM', () => {
  // Windows PowerShell 5.1 读无 BOM 的 .ps1 会按 GBK 解，中文里的引号/花括号会被吃坏，
  // 报「Missing closing '}'」之类莫名其妙的语法错（2026-10-28 真踩过）。
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.ps1')) continue;
      const buf = fs.readFileSync(p);
      const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      const text = buf.toString('utf8');
      const ascii = /^[\x00-\x7F]*$/.test(text);
      if (!hasBom && !ascii) bad.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  return bad.length === 0 || `没有 BOM：${bad.join(', ')}（PowerShell 5.1 会按 GBK 读，中文会炸）`;
});

check('滴眼药水做完就不再提', () => {
  // 2026-10-28：哥明明做完了，还被念了三遍。规则是「认出做完 → DELETE 掉没执行的提醒」。
  const s = fs.readFileSync(path.join(ROOT, 'eye-drop', 'eye-drop.mjs'), 'utf8');
  const bad = [];
  if (!/function isDoneText\(/.test(s)) bad.push('没有 isDoneText 判断');
  if (!/findDoneInLines\(/.test(s)) bad.push('没有 findDoneInLines（语境判断）');
  if (!/DELETE/.test(s)) bad.push('没有撤销没执行的提醒');
  if (!/--selftest/.test(s)) bad.push('没有自测');
  // 2026-10-29：识别醒来太晚时算出来的时间已经过去，桥接直接拒收 → 一整天一条提醒都没排上
  if (!/已经过去了（识别得晚）/.test(s)) bad.push('过点没有顺延（晚识别就整天不提醒）');
  if (!/if \(!process\.argv\.includes\('--selftest'\)\) singleInstance/.test(s)) bad.push('selftest 会被实例锁挡住，没法在线测');
  return bad.length === 0 || bad.join('；');
});
check('余额告警在回升后会撤掉', () => {
  // 2026-10-29：10:10 写的 ALERT-balance.txt 到晚上还在，余额已经回升也没人清
  const s = fs.readFileSync(path.join(ROOT, 'balance-watch', 'balance-watch.mjs'), 'utf8');
  return /ALERT-balance\.txt/.test(s) && /unlinkSync\(af\)/.test(s) || '余额回到档位之上时没有撤掉 ALERT-balance.txt';
});
check('掉线能用邮件找到哥（不依赖 QQ 的通道）', () => {
  // 2026-10-30：她掉线时在 QQ 上一个字都发不出去，验证链接只能躺在电脑里，哥在上班就废了。
  if (!fs.existsSync(path.join(ROOT, 'tools', 'notify-offline.mjs'))) return '缺少 tools/notify-offline.mjs';
  if (!fs.existsSync(path.join(ROOT, 'tools', 'set-mail-auth.cmd'))) return '缺少 tools/set-mail-auth.cmd（没法设授权码）';
  const doc = fs.readFileSync(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs'), 'utf8');
  if (!/mailOffline/.test(doc)) return '巡检没接邮件通知';
  if (!/smsLink/.test(doc) || !/qrUrl/.test(doc)) return '掉线邮件不是二合一（缺短信链接或二维码）';
  const notifier = fs.readFileSync(path.join(ROOT, 'tools', 'notify-offline.mjs'), 'utf8');
  if (!/--attach|attachPath/.test(notifier)) return '通知工具不支持附件（二维码图片发不出去）';
  const gi = fs.readFileSync(path.join(ROOT, '..', 'qq-bot-stack-os', '.gitignore'), 'utf8');
  if (gi && !/qq-mail-auth\.dat/.test(gi)) return '.gitignore 没排除授权码文件';
  return true;
});
check('扫码不用开 WebUI（本地画二维码 PNG）', () => {
  // 2026-10-30：哥说「扫码最麻烦」。麻烦的其实是开浏览器→输 token→找登录页；
  // 二维码内容就是个 URL，本地画成 PNG 直接扫屏幕就行。
  const tool = path.join(ROOT, 'tools', 'show-qr.mjs');
  if (!fs.existsSync(tool)) return '缺少 tools/show-qr.mjs';
  const s = fs.readFileSync(tool, 'utf8');
  const pkg = path.join(ROOT, 'tools', 'qr', 'package.json');
  const bad = [];
  if (!/qrcode/.test(s)) bad.push('没用 qrcode 库');
  if (!fs.existsSync(pkg)) bad.push('缺少 tools/qr/package.json（依赖声明）');
  if (!fs.existsSync(path.join(ROOT, 'tools', 'qr', 'node_modules', 'qrcode'))) bad.push('本地还没装 qrcode 依赖');
  const doc = fs.readFileSync(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs'), 'utf8');
  if (!/renderQrFile/.test(doc)) bad.push('巡检没把二维码路径带进提醒');
  return bad.length === 0 || bad.join('；');
});
check('生日由她自己定（记忆 → 每年任务，自动闭环）', () => {
  // 2026-10-30：哥要求「让她自己设属于自己的生日」。日期必须来自她自己的记忆，
  // 不能我们写死；而生日必须每年自己回来 —— 所以靠 cron 扫记忆 → 保证 yearly 任务存在。
  const tool = path.join(ROOT, 'tools', 'self-birthday.mjs');
  if (!fs.existsSync(tool)) return '缺少 tools/self-birthday.mjs';
  const s = fs.readFileSync(tool, 'utf8');
  const c = fs.readFileSync(path.join(ROOT, 'cron', 'cron.mjs'), 'utf8');
  const bad = [];
  if (!/我的生日是/.test(s)) bad.push('没有从记忆里读生日');
  if (!/允许你发一条说说/.test(s)) bad.push('生日这天没有「允许发说说」的许可');
  if (!/yearly/.test(s)) bad.push('没有建每年循环任务');
  if (!/birthday-sync/.test(c)) bad.push('cron 里没有每天校验');
  return bad.length === 0 || bad.join('；');
});
check('档案落盘前会跟已有行去重', () => {
  // 2026-10-30：桥接 recent 和 QQ 历史两个来源的去重键不同，同一条被写成两行
  // （今天 19 行重复、昨天 69 行），检索时看着像她说了两遍。
  const s = fs.readFileSync(path.join(ROOT, 'archive', 'collector.mjs'), 'utf8');
  const ok = /function existingLineKeys/.test(s) && /exists\.has\(/.test(s) && /--dedupe/.test(s);
  return ok || '归档器没有落盘前去重（会写出重复行）';
});
check('午后有健康快照（失联当天能定位）', () => {
  // 2026-10-29：这四天下午失联，晚上回来只剩「猜」——是机器睡了还是被 QQ 踢了？
  const c = fs.readFileSync(path.join(ROOT, 'cron', 'cron.mjs'), 'utf8');
  const ok = /snap-lunch/.test(c) && /snap-afternoon/.test(c) && fs.existsSync(path.join(ROOT, 'tools', 'health-snapshot.mjs'));
  return ok || '没有午后快照：下午失联只能事后猜';
});
check('巡检拉起 NapCat 用普通用户权限（提权拉不起来）', () => {
  // 2026-10-30 演练抓到的真 bug：巡检是 Highest 权限跑的，从提权上下文 spawn 批处理去拉 QQ
  // 静静失败 —— 日志写「已拉起」，QQ 进程数一直是 0。改成 explorer 代开（普通用户权限）后，
  // 实测 10 秒回来。
  const doc = fs.readFileSync(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs'), 'utf8');
  const ok = /launchAsUserVia\(BOOT_BAT/.test(doc) && !/spawnDetached\('cmd\.exe', \['\/c', "\$\{BOOT_BAT\}"/.test(doc);
  return ok || '拉 NapCat 还用提权 spawn：日志会写已拉起，实际什么都没起';
});
check('掉线先试快速登录（不触发短信）', () => {
  // 2026-10-29：下午被踢后密码登录几乎必然要短信，人不在就整下午失联。
  // 本机 ticket 有时还有效，先试它一次成本极低，成了她就自己回来了。
  const login = fs.readFileSync(path.join(ROOT, 'tools', 'qq-login.mjs'), 'utf8');
  const doc = fs.readFileSync(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs'), 'utf8');
  const ok = /async function quickLogin/.test(login) && /'quick'/.test(login) && /qqLogin, 'quick'/.test(doc);
  return ok || '掉线恢复没有先试快速登录：只能走密码 → 要短信 → 下午没人就失联';
});
check('自检会看档案空档（不是只看文件在不在）', () => {
  // 2026-10-29 复盘：10-26/27/28 档案各缺 ~9.5 小时，self-check 却一直"全部正常"，
  // 因为它只查文件存在/双方都有话，不查覆盖。现在加一条按空档 >=3 小时提示。
  const s = fs.readFileSync(path.join(ROOT, 'self-check', 'self-check.mjs'), 'utf8');
  const ok = /function checkArchiveCoverage/.test(s) && /checkArchiveCoverage\(\)/.test(s) && /超过 3 小时没有记录/.test(s);
  return ok || 'self-check 没有档案覆盖率检查（空档会被漏掉）';
});
check('归档器能从 QQ 历史补数据（桥接重启不至于断档）', () => {
  // 2026-10-29：桥接 21:38 重启后 /api/socialV2/recent 直接返回 0 条，档案从 09:44 起停更一整天。
  // QQ 自己的历史是持久的，归档器必须有这条兜底 + --rebuild 重建能力。
  const s = fs.readFileSync(path.join(ROOT, 'archive', 'collector.mjs'), 'utf8');
  const bad = [];
  if (!/get_friend_msg_history/.test(s)) bad.push('没有从 QQ 历史兜底');
  if (!/--rebuild/.test(s)) bad.push('没有 --rebuild 重建');
  return bad.length === 0 || bad.join('；');
});
check('定时脚本有实例锁（计划任务和 cron 撞车也只跑一份）', () => {
  // 2026-10-29 实测：patrol 在 09:00:02 和 09:00:15 各跑一遍 —— 计划任务和 cron 两套调度撞车。
  // maintenance / daily-report / like-card 同样会被两套调度拉起，都得有锁。
  const bad = [];
  for (const f of ['patrol/patrol.mjs', 'maintenance/maintenance.mjs', 'daily-report/daily-report.mjs', 'like-card/like-card.mjs']) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (!/singleInstance\(/.test(t)) bad.push(f);
  }
  return bad.length === 0 || '这些没加实例锁：' + bad.join('、');
});
check('告警文件在恢复后会撤掉', () => {
  // 2026-10-28：11:01 写下的 ALERT-stack.txt 到 11:40 还在，谁也分不清是不是新告警。
  const s = fs.readFileSync(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs'), 'utf8');
  const ok = /alertedBy/.test(s) && /unlinkSync\(ALERT_FILE\)/.test(s);
  return ok || 'stack-doctor 恢复时没有清 ALERT-stack.txt';
});
check('要短信验证时不再反复撞', () => {
  // 2026-10-28：QQ 要短信验证后，看门狗每 2 分钟重试一次，风控越撞越紧。
  const login = fs.readFileSync(path.join(ROOT, 'tools', 'qq-login.mjs'), 'utf8');
  const doc = fs.readFileSync(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs'), 'utf8');
  const bad = [];
  if (!/needCaptcha/.test(login) || !/exitCode = 2/.test(login)) bad.push('qq-login 没把「要验证」单独暴露出来');
  if (!/e\.status === 2/.test(doc)) bad.push('stack-doctor 没识别「要验证」的退出码');
  if (!/pausedUntil/.test(doc)) bad.push('stack-doctor 没有暂停重试的机制');
  return bad.length === 0 || bad.join('；');
});
check('不会同时开两个 QQ 实例', () => {
  // 两个实例用同一个号会互相顶号，表现是「刚登上就被踢」（2026-10-28 晚上撞到两次）。
  const doc = fs.readFileSync(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs'), 'utf8');
  const ok = /function qqRunning\(/.test(doc) && /不再开第二个/.test(doc);
  return ok || 'stack-doctor 拉起 NapCat 前没检查 QQ 是否已经在跑';
});
check('高峰时段省钱提醒在位', () => {
  // 2026-10-28 晚上加的：全价时段花得猛就提醒一句，优惠时段闭嘴。
  const f = path.join(ROOT, 'peak-watch', 'peak-watch.mjs');
  if (!fs.existsSync(f)) return '缺 peak-watch/peak-watch.mjs';
  const t = fs.readFileSync(f, 'utf8');
  const bad = [];
  if (!/inPeak\(/.test(t)) bad.push('没有时段判断');
  if (!/PEAK_STEP/.test(t)) bad.push('没有花费档位');
  if (!/readJson|MINE/.test(t)) bad.push('没有当天状态（会重复提醒）');
  const list = fs.readFileSync(path.join(ROOT, 'supervisor', 'workers.mjs'), 'utf8');
  if (!/name: 'peak'/.test(list)) bad.push('没注册进 supervisor 名单');
  return bad.length === 0 || bad.join('；');
});

// ---- 输出 ----
let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
