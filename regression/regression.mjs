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
check('月度/年度小结是她自己的口吻（不是模板）', () => {
  // 2026-10-30：哥说这两种总结按她的想法来，所以指令只约束「不能怎么写」。
  try {
    const f = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'state', 'scheduler.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const pick = (n) => (j.tasks || []).find((t) => t.name === n);
    const m = pick('月度小结');
    const y = pick('年度小结');
    if (!m || !y) return '还没建（可选，建了才检查）';
    const bad = [];
    if (!/风格随你/.test(m.instruction) || !/风格随你/.test(y.instruction)) bad.push('没有把风格交给她');
    if (!/qzone_publish/.test(m.instruction) || !/qzone_publish/.test(y.instruction)) bad.push('小结没有发到空间');
    if (!/不要在聊天里发/.test(m.instruction) || !/不要在聊天里发/.test(y.instruction)) bad.push('小结会刷聊天');
    // 注意：指令里本来就写着「别用『本月』这种词」，所以不能反向搜模板词，只能验「把风格交给她」
    return bad.length === 0 || bad.join('；');
  } catch { return '读不到 scheduler（可选检查）'; }
});
check('生日那天说说冷却会放宽', () => {
  // 2026-10-30：她 10:46 先发了一条，10:50 的生日任务想再发被 4 小时冷却挡死。
  const qz = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'src', 'mcp-qzone.mjs');
  if (!fs.existsSync(qz)) return '找不到 mcp-qzone.mjs';
  const s = fs.readFileSync(qz, 'utf8');
  const bad = [];
  if (!/specialDayToday/.test(s)) bad.push('没有特殊日子判断');
  if (!/special-days\.json/.test(s)) bad.push('没读 special-days.json');
  if (!/GAP = SPECIAL/.test(s)) bad.push('冷却没有按特殊日子放宽');
  const sp = path.join(ROOT, 'state', 'special-days.json');
  if (!fs.existsSync(sp)) bad.push('state/special-days.json 还没生成（跑一次 tools/self-birthday.mjs）');
  return bad.length === 0 || bad.join('；');
});
check('过期的一次性任务会被清掉', () => {
  // 滴眼药水每天两条，执行完变 disabled 留在列表里，两周就几十条。
  const s = fs.readFileSync(path.join(ROOT, 'maintenance', 'maintenance.mjs'), 'utf8');
  return /pruneFinishedTasks/.test(s) && /schedule\.type !== 'once'/.test(s) || 'maintenance 没有清理过期一次性任务';
});
check('有静态自查工具（找未定义调用）', () => fs.existsSync(path.join(ROOT, 'tools', 'static-audit.mjs')) || '缺 tools/static-audit.mjs');
check('充上钱的道谢每次不一样', () => {
  // 2026-10-30：以前是一句写死的「哥你充上啦，我又能说话了」，充几次就听几次。
  const s = fs.readFileSync(path.join(ROOT, 'balance-watch', 'balance-watch.mjs'), 'utf8');
  const bad = [];
  if (!/THANKS_BASE/.test(s)) bad.push('没有文案池');
  if (!/recentThanks/.test(s)) bad.push('没有记住最近用过的');
  if (!/slice\(-6\)/.test(s)) bad.push('没有「最近 6 次不重复」');
  if (!/pickThanks\(state\)/.test(s)) bad.push('发消息处没用 pickThanks');
  if (!/--selftest/.test(s)) bad.push('没有自测');
  return bad.length === 0 || bad.join('；');
});
check('余额告警在回升后会撤掉', () => {
  // 2026-10-29：10:10 写的 ALERT-balance.txt 到晚上还在，余额已经回升也没人清
  const s = fs.readFileSync(path.join(ROOT, 'balance-watch', 'balance-watch.mjs'), 'utf8');
  const back = /ALERT-balance\.txt/.test(s) && /unlinkSync\(af\)/.test(s);
  const lenient = /放宽日：撤掉旧的余额告警文件/.test(s);
  return (back && lenient) || '余额回升/放宽日时没有撤掉 ALERT-balance.txt';
});
check('启动 NapCat 只有一个入口（防止两个实例抢号）', () => {
  // 2026-10-30：巡检每 2 分钟拉起 + 手动拉起 → 两棵树互相踢，二维码刚扫就失效。
  const starter = path.join(ROOT, 'tools', 'napcat-start.mjs');
  if (!fs.existsSync(starter)) return '缺少 tools/napcat-start.mjs';
  const s = fs.readFileSync(starter, 'utf8');
  const bat = fs.readFileSync(path.join(ROOT, 'napcat-boot.bat'), 'utf8');
  const doc = fs.readFileSync(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs'), 'utf8');
  const bad = [];
  if (!/singleInstance\('napcat-start'\)/.test(s)) bad.push('启动器没加锁');
  if (!/qqRunning/.test(s)) bad.push('启动器没检查 QQ 进程');
  if (!/portOpen\(3000\)/.test(s)) bad.push('启动器没检查 3000');
  if (!/napcat-start\.mjs/.test(bat)) bad.push('napcat-boot.bat 没走启动器');
  if (!/napcat-start\.mjs/.test(doc)) bad.push('巡检没走启动器');
  return bad.length === 0 || bad.join('；');
});
check('登录成功后清掉多余 QQ 实例', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs'), 'utf8');
  return /killStrayQQ/.test(doc) && /if \(nc\.ok\) killStrayQQ\(\)/.test(doc) || '巡检没清理多余实例（会互相踢）';
});
check('有防封号的三道闸（次数/夜间/主动下线）', () => {
  // 2026-10-30 的反面教材：11:25~11:40 连续试了十几次，风控从短信升到识图、再到长冷却。
  const doc = fs.readFileSync(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs'), 'utf8');
  const bad = [];
  if (!/LOGIN_ATTEMPT_CAP/.test(doc) || !/loginBudget/.test(doc)) bad.push('没有每日登录次数预算');
  if (!/nightQuiet/.test(doc)) bad.push('夜间没有静默（会被半夜验证）');
  if (!/主动下线/.test(doc)) bad.push('超限没有主动下线');
  return bad.length === 0 || bad.join('；');
});
check('掉线邮件里带扫码页链接，且页面会自己拉起来', () => {
  // 2026-10-30：哥要求把「会自己刷新二维码」的页面链接也塞进掉线邮件。
  const doc = fs.readFileSync(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs'), 'utf8');
  const bad = [];
  if (!/ensureQrLive/.test(doc)) bad.push('巡检没确保扫码页在跑');
  if (!/127\.0\.0\.1:7788/.test(doc)) bad.push('邮件正文没有扫码页链接');
  return bad.length === 0 || bad.join('；');
});
check('扫码页会自己刷新（码不会过期）', () => {
  const f = path.join(ROOT, 'tools', 'qr-live.mjs');
  if (!fs.existsSync(f)) return '缺少 tools/qr-live.mjs';
  const s = fs.readFileSync(f, 'utf8');
  return /RefreshQRcode/.test(s) && /setInterval/.test(s) || '扫码页没有自动刷新';
});
check('链接过期会自动再发一封（不用干等 6 小时）', () => {
  // 2026-10-30：人在上班，30 分钟没看手机链接就废了；以前下一次要等 6 小时。
  const login = fs.readFileSync(path.join(ROOT, 'tools', 'qq-login.mjs'), 'utf8');
  const doc = fs.readFileSync(path.join(ROOT, 'stack-doctor', 'stack-doctor.mjs'), 'utf8');
  const bad = [];
  if (!/qq-verify-timeout\.json/.test(login)) bad.push('轮询超时没留标记');
  if (!/verifyTimedOutRecently/.test(doc)) bad.push('巡检没读超时标记');
  if (!/pauseH/.test(doc)) bad.push('超时后没缩短重试间隔');
  if (!/mailLeftToday/.test(doc)) bad.push('邮件没有每日上限');
  return bad.length === 0 || bad.join('；');
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
  if (!/按你自己的想法写/.test(s)) bad.push('生日说说没有「按她自己的想法写」');
  if (!/ensureYearly\('他的生日'/.test(s)) bad.push('没有给主人也建生日任务');
  if (!/lenientDates/.test(s)) bad.push('生日没有写进余额放宽日');
  const bw = fs.readFileSync(path.join(ROOT, 'balance-watch', 'balance-watch.mjs'), 'utf8');
  if (!/isLenientDay/.test(bw)) bad.push('balance-watch 没接放宽日');
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

check('主脑一个入口管所有 worker', () => {
  // 2026-10-30：原来 supervisor 拉进程、stack-guard 守窗口、doctor 数锁，三处各管一半；
  // 现在统一到 brain.mjs，名单还是读 supervisor/workers.mjs（只留一份）。
  const f = path.join(ROOT, 'brain.mjs');
  if (!fs.existsSync(f)) return '缺 brain.mjs';
  const t = fs.readFileSync(f, 'utf8');
  const bad = [];
  if (!/supervisor',\s*'workers\.mjs'/.test(t)) bad.push('没从 workers.mjs 读名单');
  if (!/function start\(/.test(t)) bad.push('不会拉起 worker');
  if (!/child\.on\('exit'/.test(t)) bad.push('worker 退出后不重启');
  if (!/brain\.json/.test(t)) bad.push('不落状态文件');
  if (!/--status/.test(t)) bad.push('没有 --status');
  return bad.length === 0 || bad.join('；');
});
check('主脑和旧 supervisor 互斥（不会两边抢 worker）', () => {
  // 实际撞过：主脑的 9 个子进程全因锁冲突退出，锁却被 supervisor 的 worker 占着，
  // 状态表显示「全停了」但机器上确实有 worker 在跑 —— 最难查的一种。
  const t = fs.readFileSync(path.join(ROOT, 'brain.mjs'), 'utf8');
  const bad = [];
  if (!/claimSupervisorRole\(/.test(t)) bad.push('主脑没占 supervisor 角色锁');
  if (!/takeOverSupervisor\(/.test(t)) bad.push('启动时没接管旧 supervisor');
  const g = fs.readFileSync(path.join(ROOT, 'stack-guard', 'stack-guard.mjs'), 'utf8');
  if (!/readPid\('brain'\)/.test(g)) bad.push('守夜人还在盯 supervisor');
  return bad.length === 0 || bad.join('；');
});
check('开机脚本跑主脑，且锁冲突时不空转', () => {
  // 装机目录里是 install.ps1 现生成的 20-supervisor.bat；仓库里没有这个文件，
  // 所以没装的时候退回去检查生成器（两份总得有一份是对的）。
  const bad = [];
  const f = path.join(ROOT, '20-supervisor.bat');
  if (fs.existsSync(f)) {
    const t = fs.readFileSync(f, 'utf8');
    if (!/brain\.mjs/.test(t)) bad.push('bat 没跑 brain.mjs');
    if (!/ERRORLEVEL/i.test(t)) bad.push('bat 退出码 3 还会死循环重启');
    // .bat 只能 ASCII：中文注释会被 cmd 吃成乱码，甚至改变解析
    if (/[^\x00-\x7F]/.test(t)) bad.push('bat 含非 ASCII 字符（cmd 会乱码）');
  }
  const inst = path.join(ROOT, 'install.ps1');
  if (!fs.existsSync(inst)) {
    if (!fs.existsSync(f)) bad.push('既没有 20-supervisor.bat 也没有 install.ps1');
  } else {
    const s = fs.readFileSync(inst, 'utf8');
    if (!/Write-Launcher '20-supervisor\.bat'[\s\S]{0,400}?brain\.mjs/.test(s)) bad.push('install.ps1 生成的启动脚本还是旧 supervisor');
    if (!/ERRORLEVEL/i.test(s)) bad.push('install.ps1 生成的启动脚本没有锁冲突退出');
  }
  return bad.length === 0 || bad.join('；');
});

check('主脑自己会拿主意（不是只会重启）', () => {
  // 每一条都对应真出过的事：卡死、反复崩、坏依赖、桥接断、巡检停、日志涨爆、孤儿锁。
  // 拆成三脑后，判据分散在 brain.mjs 和 hemis/right.mjs 里 —— 两边都要有。
  const t = fs.readFileSync(path.join(ROOT, 'brain.mjs'), 'utf8');
  const r = fs.readFileSync(path.join(ROOT, 'hemis', 'right.mjs'), 'utf8');
  const bad = [];
  const need = [
    [t, 'function decide(', '没有决策记录'],
    [t, /quarantineUntil/, '反复崩不隔离'],
    [t, /Cannot find module/, '坏依赖不识别'],
    [r, /lockAgeSec > 180/, '卡死不重启'],
    [r, /start-bridge/, '桥接断了不拉起'],
    [r, /run-doctor/, '巡检停了不管'],
    [t, /function trimLogs\(/, '日志涨爆不裁剪'],
    [t, /function killOrphan\(/, '孤儿锁不回收'],
  ];
  for (const [src, re, why] of need) if (!(re instanceof RegExp ? re.test(src) : src.includes(re))) bad.push(why);
  if (!/--decisions/.test(t)) bad.push('没有 --decisions（出事了查不了它当时怎么想的）');
  return bad.length === 0 || bad.join('；');
});
check('守夜人只管主脑，不跟它抢着拉东西', () => {
  // 两处都动手 = 谁先谁后看运气，日志还会说谎（10-30 撞过）。
  const g = fs.readFileSync(path.join(ROOT, 'stack-guard', 'stack-guard.mjs'), 'utf8');
  const bad = [];
  if (/bridge\.js/.test(g)) bad.push('守夜人还在自己拉桥接');
  if (!/brain\.mjs/.test(g)) bad.push('守夜人不保主脑');
  return bad.length === 0 || bad.join('；');
});
check('主脑默认开机自启', () => {
  // 计划任务优先（登录后 20 秒，静默）；装不上时靠启动文件夹兜底。
  const inst = path.join(ROOT, 'install.ps1');
  const bad = [];
  if (fs.existsSync(inst)) {
    const s = fs.readFileSync(inst, 'utf8');
    if (!/QQBotBrain/.test(s)) bad.push('install.ps1 没注册主脑自启任务');
    if (!/20-supervisor\.bat/.test(s)) bad.push('自启任务没指到启动脚本');
  }
  const startup = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'qqbot-supervisor.cmd');
  if (fs.existsSync(startup)) {
    if (!/20-supervisor\.bat/.test(fs.readFileSync(startup, 'utf8'))) bad.push('启动文件夹那个没跑主脑');
  }
  if (bad.length === 0) return true;
  return bad.join('；');
});

check('三脑各管一摊，主脑仲裁', () => {
  // 左脑=安全/封号，右脑=运行逻辑，小脑=记忆/输出/余额，谁都不能越权直接动手。
  const bad = [];
  const L = path.join(ROOT, 'hemis', 'left.mjs');
  const R = path.join(ROOT, 'hemis', 'right.mjs');
  const C = path.join(ROOT, 'hemis', 'cerebellum.mjs');
  for (const [f, why] of [[L, '左脑'], [R, '右脑'], [C, '小脑']]) if (!fs.existsSync(f)) bad.push('缺' + why);
  if (bad.length) return bad.join('；');

  const l = fs.readFileSync(L, 'utf8');
  if (!/LOGIN_CAP/.test(l)) bad.push('左脑没有登录次数闸门');
  if (!/23:00|night/.test(l)) bad.push('左脑没有夜间闸门');
  if (!/group-message/.test(l)) bad.push('左脑不管群消息');
  if (!/SAFE_DEFAULT/.test(l)) bad.push('左脑没有「它自己坏了」的保守策略');

  const r = fs.readFileSync(R, 'utf8');
  if (/spawn\(/.test(r)) bad.push('右脑自己动手了（应该只提 proposal）');
  if (!/start-bridge/.test(r) || !/start-worker/.test(r)) bad.push('右脑不提运行提案');

  const c = fs.readFileSync(C, 'utf8');
  if (!/memory-tidy/.test(c)) bad.push('小脑不管记忆整理');
  if (!/run-memory-summary/.test(c)) bad.push('小脑不管每天摘要');
  if (!/send-mail/.test(c)) bad.push('小脑不管余额提醒');
  if (!/save-mode/.test(c)) bad.push('小脑不管省着聊');

  const b = fs.readFileSync(path.join(ROOT, 'brain.mjs'), 'utf8');
  if (!/function gate\(/.test(b)) bad.push('主脑没有闸门');
  if (!/noteConflict/.test(b)) bad.push('主脑不记冲突');
  if (!/自己下线/.test(b)) bad.push('冲突后不会自己下线');
  if (!/hemis\/cerebellum|hemis\/left|hemis\/right/.test(b)) bad.push('主脑没接三脑');
  return bad.length === 0 || bad.join('；');
});
check('主脑接管 NapCat 和桥接（那两个快捷方式只是叫它起床）', () => {
  const b = fs.readFileSync(path.join(ROOT, 'brain.mjs'), 'utf8');
  const bad = [];
  if (!/function spawnBridge\(/.test(b)) bad.push('主脑不拉桥接');
  if (!/function spawnNapcat\(/.test(b)) bad.push('主脑不拉 NapCat');
  if (!/napcat-start\.mjs/.test(b)) bad.push('拉 NapCat 没走唯一入口');
  for (const f of ['1-启动NapCat.bat', '2-启动桥接.bat']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf8');
    if (!/20-supervisor\.bat/.test(t)) bad.push(f + ' 还在自己拉服务');
    if (/src\\bridge\.js|launcher\.bat/.test(t)) bad.push(f + ' 里还有旧启动逻辑');
  }
  return bad.length === 0 || bad.join('；');
});
check('小脑的「省着聊」真的会被执行', () => {
  const bw = path.join(ROOT, 'balance-watch', 'balance-watch.mjs');
  if (!fs.existsSync(bw)) return '缺 balance-watch';
  const t = fs.readFileSync(bw, 'utf8');
  if (!/cerebellum-policy\.json/.test(t)) return 'balance-watch 不读小脑的省聊策略';
  return true;
});

check('左手只清垃圾，而且删得回来', () => {
  const f = path.join(ROOT, 'hands', 'left-hand.mjs');
  if (!fs.existsSync(f)) return '缺 hands/left-hand.mjs';
  const t = fs.readFileSync(f, 'utf8');
  const bad = [];
  if (!/trash/.test(t)) bad.push('不往 trash 里搬（直接删就没法捞）');
  if (!/manifest\.json/.test(t)) bad.push('没有清单');
  if (!/SKIP_DIRS/.test(t)) bad.push('没有跳过 dsh-qq/node_modules');
  if (!/MAX_FILES/.test(t)) bad.push('没有单次上限');
  if (!/cpSync/.test(t)) bad.push('跨盘/被占用时没有回退方案');
  return bad.length === 0 || bad.join('；');
});
check('右手删记忆走桥接接口，而且先备份', () => {
  const f = path.join(ROOT, 'hands', 'right-hand.mjs');
  if (!fs.existsSync(f)) return '缺 hands/right-hand.mjs';
  const t = fs.readFileSync(f, 'utf8');
  const bad = [];
  if (!/memory-remove/.test(t)) bad.push('不走 memory-remove（直接改文件会被桥接覆盖）');
  if (!/backup-/.test(t)) bad.push('删之前没备份');
  if (!/MAX_REMOVE/.test(t)) bad.push('没有单次上限');
  if (!/const CATS/.test(t)) bad.push('没限定只处理记忆类别');
  return bad.length === 0 || bad.join('；');
});
check('有一个脱离主脑、能把主脑救回来的急救员', () => {
  const f = path.join(ROOT, 'medic', 'medic.mjs');
  if (!fs.existsSync(f)) return '缺 medic/medic.mjs';
  const t = fs.readFileSync(f, 'utf8');
  const bad = [];
  if (/from '\.\.\/brain\.mjs'|from '\.\.\/hemis/.test(t)) bad.push('它依赖主脑代码（主脑坏了它也起不来）');
  if (!/function brainState\(/.test(t)) bad.push('不判断主脑死活');
  if (!/frozen/.test(t)) bad.push('不处理卡死');
  if (!/spawnBrain/.test(t)) bad.push('不会拉起主脑');
  if (!/ALERT-/.test(t)) bad.push('救不回来时不告警');
  if (!fs.existsSync(path.join(ROOT, 'medic-start.cmd'))) bad.push('缺 medic-start.cmd（开机靠它起来）');
  return bad.length === 0 || bad.join('；');
});
check('主脑有最高决策权：越权和维持', () => {
  const t = fs.readFileSync(path.join(ROOT, 'brain.mjs'), 'utf8');
  const bad = [];
  if (!/function tryOverride\(/.test(t)) bad.push('没有越权通道');
  if (!/主脑-越权/.test(t)) bad.push('越权不留痕');
  if (!/async function maintain\(/.test(t)) bad.push('没有维持逻辑（磁盘/内存）');
  if (!/statfs/.test(t)) bad.push('不看磁盘');
  if (!/memoryUsage\(\)/.test(t)) bad.push('不看自己内存');
  return bad.length === 0 || bad.join('；');
});

check('嘴默认闭着，只把「谁死了/谁摸鱼」报给主脑', () => {
  const f = path.join(ROOT, 'mouth', 'mouth.mjs');
  if (!fs.existsSync(f)) return '缺 mouth/mouth.mjs';
  const t = fs.readFileSync(f, 'utf8');
  const bad = [];
  if (!/mouth-report\.json/.test(t)) bad.push('不写报告给主脑');
  if (!/dead/.test(t) || !/idle/.test(t)) bad.push('不分「死」和「摸鱼」');
  if (!/canWork/.test(t)) bad.push('不说能不能干活');
  if (/killTree|spawn\(process\.execPath/.test(t)) bad.push('嘴自己动手了（它只该看和报）');
  if (!/CHECK_MS/.test(t)) bad.push('不定时看');
  return bad.length === 0 || bad.join('；');
});
check('急救队列：主脑起来后接着救其余的脑', () => {
  const b = fs.readFileSync(path.join(ROOT, 'brain.mjs'), 'utf8');
  const m = fs.readFileSync(path.join(ROOT, 'medic', 'medic.mjs'), 'utf8');
  const bad = [];
  if (!/heal-queue\.json/.test(b) || !/consumeHealQueue/.test(b)) bad.push('主脑不消费急救队列');
  if (!/revive-hemi/.test(b)) bad.push('主脑不会复活其他脑');
  if (!/function queueHeal/.test(m)) bad.push('急救员不会写队列');
  if (!/checkHemis/.test(m)) bad.push('急救员不检查哪个脑下线太久');
  if (!/commandHands/.test(m)) bad.push('急救员接管时不指挥左手');
  return bad.length === 0 || bad.join('；');
});
check('急救员清场不误伤「本体」的锁', () => {
  // 实际踩过：清场时把 bridge.lock 当 worker 锁，杀了桥接，主脑又得重拉
  const m = fs.readFileSync(path.join(ROOT, 'medic', 'medic.mjs'), 'utf8');
  if (!/workerNames\(\)/.test(m)) return '清场没有限定在 worker 锁上';
  if (/f\.endsWith\('\.lock'\) && !\['medic\.lock', 'eye\.lock'\]/.test(m)) return '还在按后缀清所有锁';
  return true;
});

check('主脑能拉起死掉的器官、救不活的脑就造一个新的', () => {
  const b = fs.readFileSync(path.join(ROOT, 'brain.mjs'), 'utf8');
  const bad = [];
  if (!/ORGAN_ENTRY/.test(b) || !/function spawnOrgan/.test(b)) bad.push('不会重拉眼/嘴/急救员');
  if (!/function watchOrgans/.test(b)) bad.push('不看器官死活');
  if (!/hemiGen/.test(b) || !/function reviveHemi/.test(b)) bad.push('不会造新脑');
  if (!/import\(`\.\/hemis\/\$\{name\}\.mjs\?gen=/.test(b)) bad.push('造新脑没换模块实例（状态不会清零）');
  if (!/hemiFail/.test(b)) bad.push('没有「几次救不回来才重造」的计数');
  return bad.length === 0 || bad.join('；');
});
check('主脑自律：扫过的二维码框自己收掉', () => {
  const b = fs.readFileSync(path.join(ROOT, 'brain.mjs'), 'utf8');
  const bad = [];
  if (!/async function discipline/.test(b)) bad.push('没有自律逻辑');
  if (!/qr-screen\.json/.test(b)) bad.push('不看扫码框开了多久');
  if (!/关掉扫过的二维码框/.test(b)) bad.push('登录后不收扫码框');
  const q = fs.readFileSync(path.join(ROOT, 'tools', 'qr-screen.mjs'), 'utf8');
  if (!/qr-black\.ps1/.test(q)) bad.push('扫码黑屏没接上');
  const ps = path.join(ROOT, 'tools', 'qr-black.ps1');
  if (!fs.existsSync(ps)) bad.push('缺 qr-black.ps1');
  else if (/[^\x00-\x7F]/.test(fs.readFileSync(ps, 'utf8'))) bad.push('qr-black.ps1 含非 ASCII（PS5.1 会解析失败）');
  return bad.length === 0 || bad.join('；');
});
check('眼看到的东西会经嘴转述给主脑', () => {
  const m = fs.readFileSync(path.join(ROOT, 'mouth', 'mouth.mjs'), 'utf8');
  const bad = [];
  if (!/eye-findings\.json/.test(m)) bad.push('嘴不读眼的报告');
  if (!/eyeSaw/.test(m)) bad.push('报告里没有眼的内容');
  if (!/转述眼/.test(m)) bad.push('日志里不转述');
  const e = fs.readFileSync(path.join(ROOT, 'eye', 'eye.mjs'), 'utf8');
  if (!/eye-findings\.json/.test(e)) bad.push('眼不写报告');
  return bad.length === 0 || bad.join('；');
});

check('主脑看占用、超阈值就降优先级', () => {
  const b = fs.readFileSync(path.join(ROOT, 'brain.mjs'), 'utf8');
  const bad = [];
  if (!/function sampleProcesses/.test(b)) bad.push('不采样进程占用');
  if (!/WorkingSet64/.test(b) || !/\.CPU/.test(b)) bad.push('不读内存/CPU');
  if (!/function setPriority/.test(b)) bad.push('不会改优先级');
  if (!/PriorityClass = 'Idle'/.test(b)) bad.push('降占用不是真降优先级');
  if (!/function watchResources/.test(b)) bad.push('没有占用巡查');
  if (!/RSS_WARN_MB/.test(b) || !/CPU_WARN_PCT/.test(b)) bad.push('没有阈值');
  if (!/主脑-降占用/.test(b)) bad.push('降占用不留痕');
  return bad.length === 0 || bad.join('；');
});
check('降占用不长期压着：能回落、能还原', () => {
  const b = fs.readFileSync(path.join(ROOT, 'brain.mjs'), 'utf8');
  const bad = [];
  if (!/主脑-恢复占用/.test(b)) bad.push('回落后不还原优先级');
  if (!/function resetPriorities/.test(b)) bad.push('主脑重启后不还原继承下来的 Idle');
  if (!/throttled\.delete/.test(b)) bad.push('还原后不记录状态');
  return bad.length === 0 || bad.join('；');
});
check('降占用只碰自己的器官，不碰桥接和 QQ', () => {
  const b = fs.readFileSync(path.join(ROOT, 'brain.mjs'), 'utf8');
  const start = b.indexOf('function roleMap()');
  const block = start >= 0 ? b.slice(start, start + 900) : '';
  const bad = [];
  if (!block) bad.push('找不到 roleMap（怕它把 QQ 也纳进来了）');
  else if (/QQ\.exe|bridge\.js/.test(block)) bad.push('roleMap 把 QQ/桥接也算进降占用对象');
  if (/bridge/i.test(block) && /worker:/.test(block)) { /* 允许注释里提桥接 */ }
  return bad.length === 0 || bad.join('；');
});

check('理性：死掉/没用的脚本搬走并留下病因', () => {
  const L = path.join(ROOT, 'logic', 'organs.mjs');
  if (!fs.existsSync(L)) return '缺 logic/organs.mjs';
  const t = fs.readFileSync(L, 'utf8');
  const bad = [];
  if (!/function rationalPlan/.test(t)) bad.push('没有理性清理');
  if (!/function recordAutopsy/.test(t)) bad.push('不记病因');
  if (!/autopsy\.json/.test(t)) bad.push('病因不落盘（主脑存取不了）');
  if (!/function referenced\(/.test(t)) bad.push('不检查是否还被引用（会把在用的删掉）');
  if (!/trash-legacy/.test(t)) bad.push('清理不走 trash（删了捞不回来）');
  const b = fs.readFileSync(path.join(ROOT, 'brain.mjs'), 'utf8');
  if (!/主脑-理性清理/.test(b)) bad.push('主脑不执行理性清理');
  if (!/leftHand\.apply/.test(b)) bad.push('主脑没用左手搬');
  return bad.length === 0 || bad.join('；');
});
check('创造：只往 tools/gen 加，不覆盖、不碰核心代码', () => {
  const t = fs.readFileSync(path.join(ROOT, 'logic', 'organs.mjs'), 'utf8');
  const b = fs.readFileSync(path.join(ROOT, 'brain.mjs'), 'utf8');
  const bad = [];
  if (!/function creationPlan/.test(t)) bad.push('没有创造逻辑');
  if (!/tools', 'gen'/.test(t)) bad.push('生成物不在 tools/gen');
  if (!/recordCreated/.test(t)) bad.push('不记录造过什么');
  if (!/if \(fs\.existsSync\(abs\)\) continue/.test(b)) bad.push('会覆盖已有文件');
  if (!/主脑-创造工具/.test(b)) bad.push('主脑不执行创造');
  return bad.length === 0 || bad.join('；');
});
check('喜悦：连续正常一周才激励，而且有免检期', () => {
  const t = fs.readFileSync(path.join(ROOT, 'logic', 'organs.mjs'), 'utf8');
  const b = fs.readFileSync(path.join(ROOT, 'brain.mjs'), 'utf8');
  const bad = [];
  if (!/REWARD_MS = 7 \* DAY/.test(t)) bad.push('不是按 7 天算');
  if (!/function joyPlan/.test(t)) bad.push('没有喜悦逻辑');
  if (!/reward-organ/.test(t)) bad.push('不产出激励');
  if (!/rewardedUntil/.test(b)) bad.push('激励不生效（该免检时还在压它）');
  if (!/主脑-喜悦/.test(b)) bad.push('激励不留痕');
  if (!/function recordReward/.test(t)) bad.push('激励不落盘');
  return bad.length === 0 || bad.join('；');
});

check('黑匣子：一直录，出事才写事故报告', () => {
  const f = path.join(ROOT, 'blackbox', 'blackbox.mjs');
  if (!fs.existsSync(f)) return '缺 blackbox/blackbox.mjs';
  const t = fs.readFileSync(f, 'utf8');
  const bad = [];
  if (!/blackbox\.jsonl/.test(t)) bad.push('不录环形快照');
  if (!/archive', 'incidents/.test(t)) bad.push('不落事故报告');
  if (!/function problems/.test(t)) bad.push('不判断什么算问题');
  if (!/:3000|bridge/.test(t)) bad.push('不看端口');
  return bad.length === 0 || bad.join('；');
});
check('体温计：判断「有人说话但她没回」', () => {
  const f = path.join(ROOT, 'vitals', 'vitals.mjs');
  if (!fs.existsSync(f)) return '缺 vitals/vitals.mjs';
  const t = fs.readFileSync(f, 'utf8');
  const bad = [];
  if (!/api\/socialV2\/state/.test(t)) bad.push('不问桥接状态');
  if (!/unreadCount/.test(t)) bad.push('不看未读');
  if (!/lastAiReplyAt/.test(t)) bad.push('不看最后回话时间');
  if (!/vitals-alert\.json/.test(t)) bad.push('卡住不上报主脑');
  if (!/get_login_info/.test(t)) bad.push('不看 QQ 是否在线');
  return bad.length === 0 || bad.join('；');
});
check('钱包管家：算烧速和还能撑多久，提前降档', () => {
  const f = path.join(ROOT, 'treasurer', 'treasurer.mjs');
  if (!fs.existsSync(f)) return '缺 treasurer/treasurer.mjs';
  const t = fs.readFileSync(f, 'utf8');
  const bad = [];
  if (!/burnPerHour/.test(t)) bad.push('不算燃烧速率');
  if (!/etaHours/.test(t)) bad.push('不算还能撑多久');
  if (!/cerebellum-policy\.json/.test(t)) bad.push('不会提前降档');
  if (!/treasurer-alert\.json/.test(t)) bad.push('不提醒主脑');
  if (!/samples/.test(t)) bad.push('不自己记历史（只靠别人的快照）');
  return bad.length === 0 || bad.join('；');
});
check('海马体：记忆会忘，但忘得讲规矩', () => {
  const f = path.join(ROOT, 'hippocampus', 'hippocampus.mjs');
  if (!fs.existsSync(f)) return '缺 hippocampus/hippocampus.mjs';
  const t = fs.readFileSync(f, 'utf8');
  const bad = [];
  if (!/TOPIC_FORGET_DAYS = 30/.test(t)) bad.push('话题没有 30 天遗忘线');
  if (!/FACT_REVIEW_DAYS = 90/.test(t)) bad.push('事实没有 90 天复核线');
  if (!/MAX_FORGET_PER_RUN/.test(t)) bad.push('一次忘太多');
  if (!/rightHand\.apply/.test(t)) bad.push('不走右手（没有备份）');
  return bad.length === 0 || bad.join('；');
});
check('耳朵：把你的回信变成白名单指令', () => {
  const f = path.join(ROOT, 'ears', 'ears.mjs');
  if (!fs.existsSync(f)) return '缺 ears/ears.mjs';
  const t = fs.readFileSync(f, 'utf8');
  const bad = [];
  if (!/imap\.qq\.com|IMAP/.test(t)) bad.push('不收信');
  if (!/INBOX_OWNER_EMAIL|owners/.test(t)) bad.push('不限制发件人（谁都能指挥）');
  if (!/SEARCH UNSEEN/.test(t)) bad.push('只看未读');
  if (!/--selftest/.test(t)) bad.push('没有自测');
  if (!/mailN < 6|used < 6/.test(t)) bad.push('回信不设上限');
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
