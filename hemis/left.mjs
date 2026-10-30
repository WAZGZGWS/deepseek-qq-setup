/**
 * 左脑 —— 安全：只管「这件事会不会把号搞没」。
 *
 * 它不修服务、不拉进程，只回两个东西：
 *   verdicts  —— 账号相关动作能不能做（allow/deny + 理由）
 *   proposals —— 它自己要执行的安全动作（例如「发现两个 QQ 实例，清掉多的」）
 *
 * 右脑的提案必须过它的闸门；保命动作（重启 worker / 拉桥接）不经过这里 ——
 * 那些不碰 QQ 账号，卡着只会让服务死透。
 *
 * 每条红线都是真踩过才写的：
 *   · 每天登录有预算（今天试了 3 次还撞 = 送封号）
 *   · 23:00–07:00 不登录（半夜异常登录最容易触发风控）
 *   · 刚等过验证码 45 分钟内不再撞（2026-10-30 就是这么把链接撞废的）
 *   · 只允许一个 QQ 实例（两个实例互相顶号，表现是「刚登上就被踢」）
 *   · 群里一个字都不发（本套件只做私聊，群消息是最容易举报的入口）
 *   · 空间发布有每日上限（护栏在 qzone MCP 里，这里做第二道）
 *   · 一天主动说话太多 → 停主动（刷屏是最像机器人的行为）
 */

export const INFO = { name: '左脑', role: '安全/封号', version: 1 };

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const ACCOUNT_KINDS = new Set([
  'start-napcat', 'relogin', 'qr-login', 'qzone-publish', 'proactive-message', 'group-message',
]);

/** 左脑下线时（它自己坏了）主脑用的静态保守策略：一律不许碰账号 */
export const SAFE_DEFAULT = {
  online: false,
  verdicts: {
    'start-napcat': { allow: false, why: '左脑不在，按最严处理' },
    relogin: { allow: false, why: '左脑不在，按最严处理' },
    'qr-login': { allow: false, why: '左脑不在，按最严处理' },
    'qzone-publish': { allow: false, why: '左脑不在，按最严处理' },
    'proactive-message': { allow: false, why: '左脑不在，按最严处理' },
    'group-message': { allow: false, why: '左脑不在，按最严处理' },
  },
  proposals: [],
  notes: ['左脑不在，账号动作全禁（保命动作照常）'],
};

const LOGIN_CAP = 3;                    // 一天最多几次登录尝试
const VERIFY_COOL_MS = 45 * 60 * 1000;  // 等过验证码后的冷却
const PROACTIVE_DAY_CAP = 400;          // 一天这个号最多发多少条（两个方向合计，含回复）
const QZONE_DAY_CAP = 2;                // 空间每天默认上限

function tryJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * QQ 进程数。
 *
 * 这里有个必须记住的坑：一个 QQ 实例就有 4 个 QQ.exe（主进程 + GPU/渲染/工具进程），
 * 所以「数到 >1 就杀掉多余的」会把正在用的号杀掉 —— 误伤比不管更糟。
 * 真要区分实例得看命令行 --type= 或父进程，可这两样普通权限经常拿不到
 * （QQ 主进程命令行是空的、wmic 在 Win11 已移除、PS 5.1 的 CIM 在这台机器直接查不到）。
 *
 * 所以左脑的规矩是：
 *   · 不自动杀 QQ —— 唯一入口 tools/napcat-start.mjs 已经从源头禁止开第二个；
 *   · 只有进程数离谱（>8，单实例正常 4~5）才记异常，并禁止「再拉 NapCat」。
 */
let qqCache = { at: 0, total: 0 };
function qqProcesses(now) {
  if (now - qqCache.at < 60000) return qqCache.total;
  let total = 0;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    total = (out.match(/QQ\.exe/gi) || []).length;
  } catch {}
  qqCache = { at: now, total };
  return total;
}

/**
 * 今天一共说了多少句（两个方向都算）。
 *
 * 为什么不按「她的昵称」数：昵称是个人信息，不该写进代码；而且封号风险看的是
 * 这个号一天总共发了多少，把对方的话排除掉反而低估了量。
 * 档案行格式：`- 21:32 **说话人**：内容`。
 */
function spokenToday(root, now) {
  try {
    const file = path.join(root, 'archive', 'logs', `${todayKey(new Date(now))}.md`);
    const text = fs.readFileSync(file, 'utf8');
    return (text.match(/^- \d{1,2}:\d{2} \*\*[^*]+\*\*：/gm) || []).length;
  } catch { return 0; }
}

/** 空间护栏状态文件在几个可能的位置，谁先找到用谁 */
function qzoneState(ctx) {
  const cands = [];
  if (ctx.bridgeDir) {
    cands.push(path.join(ctx.bridgeDir, 'qzone-mcp-state.json'));
    cands.push(path.join(ctx.bridgeDir, 'state', 'qzone-mcp-state.json'));
  }
  if (ctx.root) cands.push(path.join(ctx.root, 'state', 'qzone-mcp-state.json'));
  for (const p of cands) {
    const s = tryJson(p);
    if (s) return s;
  }
  return null;
}

export function evaluate(ctx) {
  const now = ctx.now || Date.now();
  const root = ctx.root;
  const hour = new Date(now).getHours();
  const notes = [];
  const verdicts = {};
  const proposals = [];

  const allow = (kind, why) => { verdicts[kind] = { allow: true, why }; };
  const deny = (kind, why) => { verdicts[kind] = { allow: false, why }; };

  // ── 红线 1：单实例（不杀进程，只拦「再开一个」+ 记异常） ──────
  const qqCount = qqProcesses(now);
  if (qqCount > 8) {
    deny('start-napcat', `QQ 进程数异常（${qqCount} 个），先别再加一个`);
    notes.push(`QQ 进程数异常 ${qqCount}`);
  }

  // ── 红线 2：夜间不登录 ────────────────────────────────────────
  const night = hour >= 23 || hour < 7;
  if (night) {
    deny('relogin', '夜间（23:00–07:00）不登录');
    deny('qr-login', '夜间（23:00–07:00）不扫码');
    deny('start-napcat', '夜间不重新拉起（拉起就会触发登录）');
    deny('proactive-message', '夜间不主动说话');
  } else {
    allow('relogin', '白天');
    allow('qr-login', '白天');
  }

  // ── 红线 3：每天登录预算 ──────────────────────────────────────
  // 预算记在巡检状态里：state/stack-doctor.json → napcat.loginBudget（key 顺序踩过坑：
  // 在 doctor 里预算挂在 napcat 下面，早期版本从顶层读，永远读到 0，等于没有闸门）
  const doctor = tryJson(path.join(root, 'state', 'stack-doctor.json')) || {};
  const doctorNapcat = doctor.napcat || {};
  const lb = (doctorNapcat.loginBudget || doctor.loginBudget || {});
  const lbToday = lb.day === todayKey(new Date(now)) ? Number(lb.n || 0) : 0;
  if (lbToday >= LOGIN_CAP) {
    deny('relogin', `今天已经试了 ${lbToday} 次登录，到上限 ${LOGIN_CAP} 了`);
    deny('qr-login', `今天登录次数到上限（${lbToday}/${LOGIN_CAP}）`);
    deny('start-napcat', `今天登录次数到上限（${lbToday}/${LOGIN_CAP}），再拉也是白撞`);
    notes.push(`登录预算用尽 ${lbToday}/${LOGIN_CAP}`);
  } else if (!night) {
    verdicts.relogin = verdicts.relogin || { allow: true, why: `今天还可以试 ${LOGIN_CAP - lbToday} 次` };
  }

  // ── 红线 3.5：邮件一天最多 6 封（掉线通知和余额提醒共用这个额度） ──
  const mv = doctorNapcat.verifyMails || {};
  const mailsToday = mv.day === todayKey(new Date(now)) ? Number(mv.n || 0) : 0;
  if (night) deny('send-mail', '夜里不发邮件（他大概率睡了，早上看到也没用）');
  else if (mailsToday >= 6) deny('send-mail', `今天已经发了 ${mailsToday} 封，先别再发`);
  else allow('send-mail', `今天已发 ${mailsToday} 封`);

  // ── 红线 4：刚等过验证码，45 分钟内不再撞 ──────────────────────
  const verifyFile = path.join(root, 'state', 'qq-verify-timeout.json');
  let verifyAge = -1;
  try { verifyAge = now - fs.statSync(verifyFile).mtimeMs; } catch {}
  if (verifyAge >= 0 && verifyAge < VERIFY_COOL_MS) {
    const left = Math.ceil((VERIFY_COOL_MS - verifyAge) / 60000);
    deny('relogin', `刚等过验证码，还剩 ${left} 分钟，别连着撞`);
    deny('start-napcat', `刚等过验证码，${left} 分钟后再试`);
    notes.push(`验证冷却剩 ${left} 分钟`);
  }

  // ── 红线 5：群消息一律不发 ────────────────────────────────────
  deny('group-message', '本套件只做私聊，群消息最容易触发举报');

  // ── 红线 6：空间发布上限（第二道闸） ──────────────────────────
  const qs = qzoneState(ctx);
  let qzToday = 0;
  if (qs) {
    const today = todayKey(new Date(now));
    qzToday = Object.keys(qs.days || {}).includes(today) ? Number(qs.days[today] || 0) : Number(qs.today || 0) || 0;
    if (qs.lastDate === today && qs.lastCount) qzToday = Number(qs.lastCount) || qzToday;
  }
  if (qzToday >= QZONE_DAY_CAP) deny('qzone-publish', `今天已经发了 ${qzToday} 条，到上限 ${QZONE_DAY_CAP}`);
  else allow('qzone-publish', '空间今天还有额度');

  // ── 红线 7：主动说话别太多（像机器人） ────────────────────────
  const spoken = spokenToday(root, now);
  if (spoken >= PROACTIVE_DAY_CAP) deny('proactive-message', `今天已经说了 ${spoken} 句，停主动`);
  else if (!verdicts['proactive-message']) allow('proactive-message', `今天 ${spoken} 句，还正常`);

  return { online: true, notes, verdicts, proposals, metrics: { qqCount, loginToday: lbToday, mailsToday, spokenToday: spoken, qzoneToday: qzToday, night } };
}
