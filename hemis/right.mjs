/**
 * 右脑 —— 运行逻辑：只提「该怎么办」，不动手。
 *
 * 分工（2026-10-30 哥定的）：
 *   左脑 = 安全/封号红线，只负责「能不能做账号相关的动作」；
 *   右脑 = 运行逻辑，只负责「服务/worker 该怎么修」；
 *   主脑 = 仲裁 + 执行：右脑的提案要过左脑的闸门，冲突时右脑那一项下线。
 *
 * 右脑只产出 proposal，副作用全留给主脑（它才知道 worker 的 child 句柄、锁文件长什么样）。
 * 提案里 essential=true 的是「保命动作」（重启 worker、拉桥接、清孤儿锁），
 * 这类不会影响 QQ 账号，所以不受封号闸门限制；账号相关的（start-napcat）必须左脑点头。
 */

export const INFO = { name: '右脑', role: '运行逻辑', version: 1 };

const BRIDGE_WINDOW_MS = 15 * 60 * 1000;   // 15 分钟内最多拉 3 次桥接
const BRIDGE_MAX_TRIES = 3;
const BRIDGE_BACKOFF_MS = 10 * 60 * 1000;
const NAPCAT_STREAK_LIMIT = 3;             // 连续 3 次探测不到 :3000 才提「拉 NapCat」
const NAPCAT_RETRY_MS = 10 * 60 * 1000;    // 两次「拉 NapCat」之间至少 10 分钟
const DOCTOR_RETRY_MS = 10 * 60 * 1000;

const bridgeTries = [];
let bridgeBackoffUntil = 0;
let napcatStreak = 0;
let lastNapcatAttempt = 0;
let lastDoctorNudge = 0;

/** 主脑每轮调一次；ctx = { now, workers, ports } */
export function plan(ctx) {
  const now = ctx.now || Date.now();
  const ports = ctx.ports || {};
  const workers = ctx.workers || [];
  const proposals = [];

  // ── 保命：worker 层 ────────────────────────────────────────────
  for (const w of workers) {
    if (w.quarantineUntil > now) continue;
    if (w.brokenUntil > now) continue;

    // 活着但锁不跳 = 卡死（同步调用/死循环），重启
    if (w.alive && w.lastStart && now - w.lastStart > 240000 && w.lockAgeSec > 180) {
      proposals.push({ kind: 'restart-hung', name: w.name, essential: true, why: `锁 ${w.lockAgeSec}s 没心跳` });
      continue;
    }
    if (w.alive) continue;
    if (w.restartTimer) continue;
    // 锁还被别人新鲜占着 → 不是崩，是有人顶着
    if (w.lockAgeSec >= 0 && w.lockAgeSec < 120) continue;
    proposals.push({
      kind: 'start-worker',
      name: w.name,
      essential: true,
      why: w.lockAgeSec < 0 ? '没有锁也没在跑' : `锁 ${w.lockAgeSec}s 没心跳`,
    });
  }

  // ── 保命：端口层 ──────────────────────────────────────────────
  if (!ports.napcat) napcatStreak += 1;
  else napcatStreak = 0;

  if (ports.napcat && !ports.bridge) {
    const recent = bridgeTries.filter((t) => now - t < BRIDGE_WINDOW_MS);
    bridgeTries.length = 0;
    bridgeTries.push(...recent);
    if (now >= bridgeBackoffUntil && recent.length < BRIDGE_MAX_TRIES) {
      proposals.push({ kind: 'start-bridge', essential: true, why: 'NapCat 通、:3100 断' });
    }
  } else if (ports.bridge) {
    bridgeBackoffUntil = 0;
    bridgeTries.length = 0;
  }

  // ── 账号层：NapCat 不在，提「拉一拉」，但要左脑点头 ─────────────
  if (!ports.napcat && napcatStreak >= NAPCAT_STREAK_LIMIT && now - lastNapcatAttempt > NAPCAT_RETRY_MS) {
    proposals.push({
      kind: 'start-napcat',
      essential: false,
      why: `:3000 连续 ${napcatStreak} 次探测不到`,
    });
  }

  // ── 巡检：它负责登录预算/夜间静默那一套，主脑只负责催它 ─────────
  if (!ports.napcat && now - lastDoctorNudge > DOCTOR_RETRY_MS) {
    proposals.push({ kind: 'run-doctor', essential: true, why: 'NapCat 断了，确认巡检在跑' });
  }

  // ── 打扫 ─────────────────────────────────────────────────────
  proposals.push({ kind: 'trim-logs', essential: false, why: '日志别涨爆' });

  return { proposals, notes: [], state: { napcatStreak, bridgeBackoffUntil, bridgeTries: bridgeTries.length } };
}

/** 执行回执：主脑拉成功/失败后告诉右脑，右脑据此退避（避免「拉不起来还每秒拉」） */
export function feedback(kind, ok, at = Date.now()) {
  if (kind === 'start-bridge') {
    if (ok) { bridgeTries.length = 0; bridgeBackoffUntil = 0; }
    else {
      bridgeTries.push(at);
      const recent = bridgeTries.filter((t) => at - t < BRIDGE_WINDOW_MS);
      if (recent.length >= BRIDGE_MAX_TRIES) bridgeBackoffUntil = at + BRIDGE_BACKOFF_MS;
    }
  }
  if (kind === 'start-napcat' && ok) lastNapcatAttempt = at;
  if (kind === 'run-doctor') lastDoctorNudge = at;
}

export function reset() {
  bridgeTries.length = 0;
  bridgeBackoffUntil = 0;
  napcatStreak = 0;
  lastNapcatAttempt = 0;
  lastDoctorNudge = 0;
}

/**
 * 冷却状态落盘：主脑重启（改代码、崩溃、开机）不该让它立刻又去拉一遍。
 * 2026-10-30 实际撞到：编辑 brain.mjs 触发热重载，三次重启把「催巡检」连发了三次。
 */
export function snapshot() {
  return { bridgeTries: [...bridgeTries], bridgeBackoffUntil, napcatStreak, lastNapcatAttempt, lastDoctorNudge };
}

export function hydrate(s) {
  if (!s) return;
  bridgeTries.length = 0;
  for (const t of s.bridgeTries || []) if (typeof t === 'number') bridgeTries.push(t);
  bridgeBackoffUntil = Number(s.bridgeBackoffUntil) || 0;
  napcatStreak = Number(s.napcatStreak) || 0;
  lastNapcatAttempt = Number(s.lastNapcatAttempt) || 0;
  lastDoctorNudge = Number(s.lastDoctorNudge) || 0;
}
