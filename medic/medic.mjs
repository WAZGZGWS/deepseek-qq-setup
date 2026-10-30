#!/usr/bin/env node
/**
 * medic —— 脱离主脑独立运行的急救员。主脑挂了，它负责把主脑救回来。
 *
 * 为什么必须独立：主脑自己就是被守护的对象，它崩了、卡了、被杀了，主脑里写得再好的自愈逻辑
 * 也没人执行。所以这一层不 import 主脑的任何东西，只认两样东西：
 *   · brain.lock 里的 pid 还活着吗
 *   · brain.json（主脑每 20 秒刷新）还新鲜吗
 * 两样都不成立 = 主脑不在，救。
 *
 * 主脑在线时它保持安静：只做「不会和任何脑冲突」的小毛病——
 * 清掉指向死进程的锁文件、自己的日志别涨爆。不碰 worker、不碰 QQ、不动端口。
 *
 * 升级路径（都救不回来时）：
 *   1. 直接拉 brain.mjs
 *   2. 清掉指向死进程的锁，再拉
 *   3. 杀掉卡死的主脑（/T），再拉
 *   4. 写 ALERT-主脑.txt + 发一封邮件（每小时最多一封），等你来看
 *
 * 用法：node medic/medic.mjs        （开机由启动文件夹 / QQBotMedic 计划任务拉起）
 *       node medic/medic.mjs --status
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { ROOT, STATE, stamp, portOpen } from '../lib/base.mjs';
import * as leftHand from '../hands/left-hand.mjs';

const MEDIC_LOCK = path.join(STATE, 'medic.lock');
const MEDIC_STATE = path.join(STATE, 'medic.json');
const MEDIC_LOG = path.join(STATE, 'medic.log');
const BRAIN_LOCK = path.join(STATE, 'brain.lock');
const BRAIN_JSON = path.join(STATE, 'brain.json');
const CHECK_MS = 10000;
const BRAIN_STALE_MS = 150000;      // 主脑 20 秒一次心跳，超过 2.5 分钟就算卡死
const BOOT_WAIT_MS = 20000;
const MAX_TRIES = 3;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

const STATUS_ONLY = process.argv.includes('--status');

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  try { console.log(line); } catch {}
  try { fs.appendFileSync(MEDIC_LOG, line + '\n'); } catch {}
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }
function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 }); return true; } catch { return false; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function brainPid() {
  try { return Number(fs.readFileSync(BRAIN_LOCK, 'utf8').trim()) || 0; } catch { return 0; }
}

/** 主脑现在什么状态：alive（活且心跳新鲜）/ frozen（活着但不心跳）/ dead */
function brainState(now = Date.now()) {
  const pid = brainPid();
  const alive = pidAlive(pid);
  const jsonAt = Date.parse((readJson(BRAIN_JSON) || {}).at || '') || 0;
  const lockAge = mtime(BRAIN_LOCK) ? now - mtime(BRAIN_LOCK) : -1;
  const jsonAge = jsonAt ? now - jsonAt : -1;
  if (!alive) return { status: 'dead', pid, lockAge, jsonAge };
  const fresh = (lockAge >= 0 && lockAge < BRAIN_STALE_MS) || (jsonAge >= 0 && jsonAge < BRAIN_STALE_MS);
  return { status: fresh ? 'alive' : 'frozen', pid, lockAge, jsonAge };
}

/** 清掉「指向死进程」的锁 —— 唯一允许在主脑在线时做的小动作 */
function quietFixes(now) {
  let cleaned = 0;
  let files = [];
  try { files = fs.readdirSync(STATE).filter((f) => f.endsWith('.lock')); } catch {}
  for (const f of files) {
    if (f === 'medic.lock') continue;
    const p = path.join(STATE, f);
    let pid = 0;
    try { pid = Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch { continue; }
    if (pid && pidAlive(pid)) continue;
    if (now - mtime(p) < 5 * 60 * 1000) continue; // 刚写的先不动，可能是正在启动
    try { fs.unlinkSync(p); cleaned += 1; } catch {}
  }
  // 自己的日志别涨爆
  try {
    if (fs.statSync(MEDIC_LOG).size > 4 * 1024 * 1024) {
      fs.writeFileSync(MEDIC_LOG, fs.readFileSync(MEDIC_LOG, 'utf8').split('\n').slice(-800).join('\n'));
    }
  } catch {}
  return cleaned;
}

function spawnBrain(reason) {
  try {
    const out = fs.openSync(path.join(STATE, 'brain-boot.log'), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'brain.mjs')], {
      cwd: ROOT, stdio: ['ignore', out, out], windowsHide: true, detached: true,
    });
    child.unref();
    try { fs.closeSync(out); } catch {}
    log(`抢救：拉起主脑 pid=${child.pid}（${reason}）`);
    return child.pid;
  } catch (e) {
    log('抢救：拉起主脑失败 ' + e.message);
    return 0;
  }
}

function mailOnce(text) {
  const st = readJson(MEDIC_STATE) || {};
  const now = Date.now();
  if (now - (st.lastMailAt || 0) < ALERT_COOLDOWN_MS) return;
  st.lastMailAt = now;
  writeState(st);
  try {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'notify-offline.mjs'),
      '--subject=主脑挂了，急救员也没救回来', `--body=${text}`], {
      cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: true,
    });
    child.unref();
    log('抢救失败：已发邮件通知');
  } catch (e) { log('抢救失败：邮件也发不出去 ' + e.message); }
}

function writeState(st) {
  try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(MEDIC_STATE, JSON.stringify(st, null, 2)); } catch {}
}

// ── 眼的报告 → 自愈的解决办法库 ─────────────────────────────────────

const EYE_FINDINGS = path.join(STATE, 'eye-findings.json');
const HEAL_LIB = path.join(STATE, 'heal-library.json');
const HEAL_QUEUE = path.join(STATE, 'heal-queue.json');
// 只清 worker 锁：bridge.lock / brain.lock 这些是「本体」的锁，杀了就等于把服务干掉
function workerNames() {
  try {
    const txt = fs.readFileSync(path.join(ROOT, 'supervisor', 'workers.mjs'), 'utf8');
    return new Set([...txt.matchAll(/name:\\s*'([^']+)'/g)].map((m) => m[1]));
  } catch { return new Set(); }
}

function loadLib() { return readJson(HEAL_LIB) || { at: 0, rules: {} }; }
function saveLib(lib) { try { lib.at = new Date().toISOString(); fs.writeFileSync(HEAL_LIB, JSON.stringify(lib, null, 2)); } catch {} }
function moveAside(p, why) {
  try {
    if (!fs.existsSync(p)) return '';
    const dst = `${p}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(p, dst);
    log(`清障：${path.basename(p)}（${why}）→ ${path.basename(dst)}`);
    return dst;
  } catch { return ''; }
}
function trimLog(p, keepLines = 800) {
  try {
    if (fs.statSync(p).size < 4 * 1024 * 1024) return false;
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split('\n').slice(-keepLines).join('\n'));
    return true;
  } catch { return false; }
}

/**
 * 解决办法库：每个 finding.code 对应一组步骤（写下来是为了「下次照做」，
 * 也让哥能查「它凭什么这么修」）。steps 是给人看的，run 是真干活。
 */
const PLAYBOOKS = {
  'brain-dead': {
    steps: ['确认 brain.lock 的 pid 不在', '拉起 brain.mjs', '20 秒后复查 brain.json 是否刷新', '仍不行则升级到清锁/硬清场'],
    safeWhenBrainAlive: false,
  },
  'brain-frozen': {
    steps: ['杀掉卡死的主脑进程树', '给它 2 秒退出', '拉起新的 brain.mjs', '复查心跳'],
    safeWhenBrainAlive: false,
  },
  'medic-dead': {
    steps: ['急救员自己没在跑时由眼/启动任务拉起', '（急救员不能救自己，这条只入库备查）'],
    safeWhenBrainAlive: false,
  },
  'hemi-offline': {
    steps: ['不直接重启：等它自己的下线时间到', '若主脑 + 该脑同时不在，才在清障阶段重启主脑'],
    safeWhenBrainAlive: false,
  },
  'hemi-left-errors': {
    steps: ['主脑在线时由主脑重置左脑异常计数（它的维持逻辑）', '急救员只记录，不抢主脑的活'],
    safeWhenBrainAlive: false,
  },
  'worker-down': {
    steps: ['主脑在线：主脑的右脑负责补拉，急救员不动', '主脑不在：清障阶段一并拉起（靠 brain 启动时兜底）'],
    safeWhenBrainAlive: false,
  },
  'worker-lock-stale': {
    steps: ['主脑不在 → 杀掉占锁的进程并删锁', '主脑在线 → 不动（它自己会判卡死重启）'],
    run: async () => {
      let killed = 0;
      let files = [];
      try { files = fs.readdirSync(STATE).filter((f) => f.endsWith('.lock') && f !== 'medic.lock' && f !== 'eye.lock'); } catch {}
      for (const f of files) {
        const p = path.join(STATE, f);
        const pid = Number((fs.readFileSync(p, 'utf8') || '').trim()) || 0;
        if (pid && pidAlive(pid)) { if (killTree(pid)) killed += 1; }
      }
      return killed > 0;
    },
  },
  'port-bridge-down': {
    steps: ['主脑在线 → 它的右脑 20 秒内会拉', '主脑不在 → 急救员拉 bridge.js（只在这时候动手）'],
    run: async () => {
      try {
        const out = fs.openSync(path.join(STATE, 'bridge-run.log'), 'a');
        const child = spawn(process.execPath, [path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'src', 'bridge.js')], {
          cwd: path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0'), stdio: ['ignore', out, out], windowsHide: true, detached: true,
        });
        child.unref();
        try { fs.closeSync(out); } catch {}
        return true;
      } catch { return false; }
    },
  },
  'port-napcat-down': {
    steps: ['不自动拉 NapCat：要 UAC，登录还有次数预算', '交给巡检/主脑，急救员只记录'],
    safeWhenBrainAlive: false,
  },
  'state-corrupt': {
    steps: ['把坏掉的 JSON 改名成 .bad-<时间> 移走（主脑启动读到坏 JSON 会起不来）', '让主脑/桥接重新生成一份'],
    run: async (f) => (f.file ? !!moveAside(f.file, 'JSON 坏了，挡住主脑复活') : false),
  },
  'log-big': {
    steps: ['只保留最后 800 行', '让主脑能继续写日志'],
    run: async (f) => (f.file ? trimLog(f.file) : false),
  },
  'brain-log-error': {
    steps: ['记录最近一次未捕获异常，等主脑下一轮自己恢复', '同一小时内重复出现 → 升级为 brain-frozen 处理'],
    safeWhenBrainAlive: false,
  },
  'disk-low': {
    steps: ['清空 trash/ 里超过 7 天的桶', '裁掉大日志', '仍然紧张 → 写 ALERT-disk.txt'],
    run: async () => {
      const bin = path.join(ROOT, 'trash');
      let removed = 0;
      try {
        for (const n of fs.readdirSync(bin)) {
          const p = path.join(bin, n);
          try { if (Date.now() - fs.statSync(p).mtimeMs > 7 * 86400000) { fs.rmSync(p, { recursive: true, force: true }); removed += 1; } } catch {}
        }
      } catch {}
      for (const f of ['brain.log', 'medic.log', 'eye.log']) trimLog(path.join(STATE, f));
      return removed > 0;
    },
  },
  'qq-processes-many': {
    steps: ['只记录：不自动杀 QQ（四五个进程是正常的，杀错就把正在用的号杀了）'],
    safeWhenBrainAlive: false,
  },
  'balance-critical': {
    steps: ['只记录：余额提醒是小脑+左脑的活', '急救员不碰钱'],
    safeWhenBrainAlive: false,
  },
};

/**
 * 读眼的报告，把「解决办法」写进 solve 库并（在主脑不在时）真的执行。
 * 主脑在线时只做 safeWhenBrainAlive 的动作，别的只入库不抢活。
 */
async function healFromEye(now, brainAlive) {
  const eye = readJson(EYE_FINDINGS);
  if (!eye || !Array.isArray(eye.findings) || !eye.findings.length) return;
  const lib = loadLib();
  let acted = 0;
  for (const f of eye.findings) {
    const pb = PLAYBOOKS[f.code];
    if (!pb) continue;
    const rule = lib.rules[f.code] || { code: f.code, steps: pb.steps, hits: 0, fixed: 0 };
    rule.steps = pb.steps;
    rule.lastSeenAt = new Date(now).toISOString();
    rule.hits += 1;
    lib.rules[f.code] = rule;

    const safe = pb.safeWhenBrainAlive === true;
    if (!pb.run) continue;
    if (brainAlive && !safe) continue;      // 主脑在线：不越权，交给它
    try {
      const ok = await pb.run(f);
      if (ok) { rule.fixed += 1; rule.lastFixAt = new Date(now).toISOString(); acted += 1; }
    } catch {}
  }
  saveLib(lib);
  if (acted) log(`按眼的报告处理了 ${acted} 项（解决办法已入库 heal-library.json）`);
}

/** 把「复活主脑」这件事也写进解决办法库：不管眼有没有报，急救员自己的行动都要留档 */
function recordRule(code) {
  const pb = PLAYBOOKS[code];
  if (!pb) return;
  const lib = loadLib();
  const rule = lib.rules[code] || { code, steps: pb.steps, hits: 0, fixed: 0 };
  rule.steps = pb.steps;
  rule.hits += 1;
  rule.lastSeenAt = new Date().toISOString();
  lib.rules[code] = rule;
  saveLib(lib);
}

/**
 * 急救队列：主脑不在 / 某个脑下线太久时，把「还要谁来做」写下来。
 * 主脑一起来会消费它（被救活的脑和闲着的手要辅助复活其他脑）。
 */
function queueHeal(items) {
  if (!items || !items.length) return;
  let q = readJson(HEAL_QUEUE) || { at: 0, items: [] };
  if (!Array.isArray(q.items)) q.items = [];
  let added = 0;
  for (const it of items) {
    const dup = q.items.some((x) => x.status === 'pending' && x.kind === it.kind && (x.hemi || '') === (it.hemi || ''));
    if (dup) continue;
    q.items.push({ ...it, at: new Date().toISOString(), status: 'pending', from: 'medic' });
    added += 1;
  }
  // 只留最近 40 条，别让队列本身涨成垃圾
  q.items = q.items.slice(-40);
  if (added) {
    q.at = new Date().toISOString();
    try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(HEAL_QUEUE, JSON.stringify(q, null, 2)); } catch {}
    log(`急救队列：新增 ${added} 项，等主脑起来处理`);
  }
}

/** 主脑在线时：看看有没有哪个脑自己下线太久没恢复（超 15 分钟就排队让主脑复活它） */
function checkHemis(bj, now) {
  const h = (bj && bj.hemis) || {};
  const items = [];
  for (const name of ['left', 'right', 'cerebellum']) {
    const s = h[name];
    if (!s || s.status !== 'offline') continue;
    const offSec = Number(s.offlineSec) || 0;
    if (offSec > 900) items.push({ kind: 'revive-hemi', hemi: name, why: `自己下线 ${Math.round(offSec / 60)} 分钟` });
  }
  queueHeal(items);
}

/** 主脑不在时临时拥有最高权限：指挥左手清障（腾地方、把挡路的垃圾挪走） */
let lastHandRescueAt = 0;
function commandHands(now) {
  if (now - lastHandRescueAt < 10 * 60 * 1000) return;
  lastHandRescueAt = now;
  try {
    const hp = leftHand.plan({ root: ROOT });
    if (hp.proposals && hp.proposals.length) {
      let moved = 0;
      for (const p of hp.proposals) { const r = leftHand.apply(ROOT, p.items || []); moved += r.moved || 0; }
      if (moved) log(`临时指挥左手：清走 ${moved} 个无用文件，给主脑腾地方`);
    }
  } catch (e) { log('指挥左手失败：' + e.message); }
}

function printStatus() {
  const s = brainState();
  const st = readJson(MEDIC_STATE) || {};
  console.log(`主脑：${s.status}${s.pid ? ` (pid ${s.pid})` : ''}  锁 ${s.lockAge < 0 ? '无' : Math.round(s.lockAge / 1000) + 's'}  状态文件 ${s.jsonAge < 0 ? '无' : Math.round(s.jsonAge / 1000) + 's'}`);
  console.log(`急救员：${pidAlive(Number(fs.readFileSync(MEDIC_LOCK, 'utf8').trim() || 0)) ? '在跑' : '没在跑'}  最近抢救 ${st.lastRescueAt ? new Date(st.lastRescueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '一次都没'}`);
  console.log(`累计抢救 ${st.rescues || 0} 次，连续失败 ${st.fails || 0} 次`);
}

async function rescueLoop() {
  if (STATUS_ONLY) { printStatus(); return; }

  // 单实例：主脑可以有两个在抢锁自己退出，但急救员两个会互相抢着救
  try {
    const old = Number(fs.readFileSync(MEDIC_LOCK, 'utf8').trim()) || 0;
    if (old && old !== process.pid && pidAlive(old)) { console.log(`medic 已在跑 pid ${old}`); process.exit(3); }
  } catch {}
  try { fs.writeFileSync(MEDIC_LOCK, String(process.pid)); } catch {}
  const beat = setInterval(() => { try { fs.writeFileSync(MEDIC_LOCK, String(process.pid)); } catch {} }, 20000);
  beat.unref?.();
  process.on('exit', () => { try { if (Number(fs.readFileSync(MEDIC_LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(MEDIC_LOCK); } catch {} });

  log('急救员上岗（主脑在线时保持安静）');
  const st = readJson(MEDIC_STATE) || {};
  writeState(st);

  let tries = 0;
  let lastAttemptAt = 0;
  let downSince = 0;
  let lastAliveAt = 0;
  let lastProblemAt = 0;

  const tick = async () => {
    const now = Date.now();
    const s = brainState(now);

    if (s.status === 'alive') {
      lastAliveAt = now;
      downSince = 0;
      if (tries > 0) log('主脑回来了，权能交还，我退回静默');
      tries = 0;
      if (st.fails) { st.fails = 0; writeState(st); }
      quietFixes(now);
      // 主脑在线：只做「不会和它抢」的小修（裁日志、移走坏 JSON），其余只入库
      if (now - (st.lastHealAt || 0) > 30000) {
        st.lastHealAt = now; writeState(st);
        await healFromEye(now, true);
        checkHemis(readJson(path.join(STATE, 'brain.json')), now);
      }
      return;
    }

    // 不在（死了或卡死）：开始救
    if (now - lastProblemAt > 5 * 60 * 1000) { tries = 0; lastProblemAt = now; }
    if (!downSince) downSince = now;
    // 退避：前两次 10 秒，之后 60 秒一次，别十秒十秒地砸
    if (tries >= 3 && now - lastAttemptAt < 60000) return;
    lastAttemptAt = now;
    tries += 1;
    st.rescues = (st.rescues || 0) + 1;
    st.lastRescueAt = now;
    writeState(st);

    // 主脑不在时：暂时接管，先把「可能阻碍复活的」清掉（坏 JSON、僵住的锁、涨爆的日志、断掉的桥接）
    if (tries === 1) {
      recordRule(s.status === 'frozen' ? 'brain-frozen' : 'brain-dead');
      queueHeal([{ kind: 'rescue-brain', why: s.status === 'frozen' ? '主脑卡死' : '主脑不在' }]);
      commandHands(now);
      const lib = loadLib();
      const badState = ['right-brain.json', 'cerebellum.json', 'brain.json', 'medic.json', 'brain-restart-reason.json'];
      for (const n of badState) {
        const p = path.join(STATE, n);
        if (fs.existsSync(p) && !readJson(p)) moveAside(p, '坏 JSON 会让主脑起不来');
      }
      for (const f of ['brain.log', 'medic.log', 'eye.log']) trimLog(path.join(STATE, f));
      let killed = 0;
      let files = [];
      const wn = workerNames();
      try { files = fs.readdirSync(STATE).filter((f) => f.endsWith('.lock') && wn.has(f.replace(/\.lock$/, ''))); } catch {}
      for (const f of files) {
        const p = path.join(STATE, f);
        const pid = Number(((() => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return 0; } })()) || 0);
        if (!pid) { try { fs.unlinkSync(p); } catch {} continue; }
        if (pidAlive(pid) && pid !== s.pid) { if (killTree(pid)) killed += 1; try { fs.unlinkSync(p); } catch {} }
        else if (!pidAlive(pid)) { try { fs.unlinkSync(p); } catch {} }
      }
      if (killed) log(`清障：先收了 ${killed} 个还占着锁的进程`);
      lib.cleared = (lib.cleared || 0) + 1;
      lib.lastClearedAt = new Date(now).toISOString();
      saveLib(lib);
      await healFromEye(now, false);
    }

    if (s.status === 'frozen') {
      log(`主脑卡住了（pid ${s.pid}，${Math.round(s.jsonAge / 1000)}s 没心跳），先杀掉再拉`);
      killTree(s.pid);
      await sleep(2000);
    }

    if (tries === 1) {
      spawnBrain(s.status === 'frozen' ? '卡死后重启' : '主脑不在');
    } else if (tries === 2) {
      const cleaned = quietFixes(now);
      log(`第二次救：先清了 ${cleaned} 个死锁，再拉`);
      spawnBrain('第二次');
    } else if (tries >= MAX_TRIES) {
      log(`第 ${tries} 次还是不行，进入硬清场：杀掉所有占着 worker 锁的进程`);
      let files = [];
      try { files = fs.readdirSync(STATE).filter((f) => f.endsWith('.lock')); } catch {}
      for (const f of files) {
        if (f === 'medic.lock') continue;
        const pid = Number((() => { try { return fs.readFileSync(path.join(STATE, f), 'utf8').trim(); } catch { return 0; } })()) || 0;
        if (pid && pidAlive(pid)) killTree(pid);
        try { fs.unlinkSync(path.join(STATE, f)); } catch {}
      }
      spawnBrain('硬清场后');
      st.fails = (st.fails || 0) + 1;
      writeState(st);
      if (tries >= MAX_TRIES + 2) {
        const downFor = downSince ? now - downSince : 0;
        const wasAliveRecently = lastAliveAt && now - lastAliveAt < 120000;
        // 只在「真的连续断了 5 分钟、且最近没活过」时才吵他。
        // 2026-10-30 半夜误发过一封：我在改代码反复重启主脑，急救员 40 秒内试了 5 次就发了邮件。
        if (downFor < 5 * 60 * 1000 || wasAliveRecently) {
          log(`抢救失败 ${tries} 次，但只断了 ${Math.round(downFor / 1000)} 秒（${wasAliveRecently ? '刚还活着过' : '还没满 5 分钟'}），先不发邮件`);
        } else {
          try {
            fs.writeFileSync(path.join(STATE, 'ALERT-主脑.txt'),
              `[${stamp()}] 主脑反复救不回来（连续 ${tries} 次，断了 ${Math.round(downFor / 60000)} 分钟）。\n` +
              `端口：NapCat ${await portOpen(3000).catch(() => false) ? '通' : '断'}，桥接 ${await portOpen(3100).catch(() => false) ? '通' : '断'}\n` +
              `看 ${MEDIC_LOG}\n`);
          } catch {}
          mailOnce(`主脑连续 ${tries} 次没救回来（断了 ${Math.round(downFor / 60000)} 分钟）。\n先看 E:\\1\\qq-stack\\state\\medic.log 和 brain.log。\n（如果是我在改代码/手动重启，忽略这封；真救不回来我才会发）`);
        }
        tries = 0;
      }
    }

    // 给新起的进程 20 秒，然后下一轮检查（不在这里阻塞太久）
    await sleep(BOOT_WAIT_MS);
  };

  // 启动先看一眼，然后 10 秒一轮
  await tick();
  setInterval(() => { void tick().catch((e) => log('急救出错：' + e.message)); }, CHECK_MS);
}

rescueLoop();
