import fs from 'node:fs';
import path from 'node:path';

/**
 * 单实例锁：同名 worker 只允许一个实例。
 *
 * 判活这块踩过两次坑，先说清楚为什么改成心跳：
 *
 *   1) 只看「pid 还活着」不行 —— Windows 会把 pid 复用给别的进程，
 *      复用了就变成僵尸锁，新实例自杀、supervisor 狂重启。
 *   2) 想核对命令行也不行 —— wmic 在 Win11 已经被移除，退化到 tasklist
 *      只能拿到进程名（node.exe），拿不到"跑的是哪个脚本"，等于没判。
 *
 * 所以用最可靠的办法：活着的实例每 20 秒刷新一次锁文件的 mtime。
 * 锁超过 90 秒没被刷新，就认定持有者已经死了，直接接管。
 * 这个判断跟 pid 复用完全无关，也不依赖任何外部命令。
 */

const HEARTBEAT_MS = 20 * 1000;
const STALE_MS = 90 * 1000;

export function singleInstance(name, stateDir) {
  const dir = stateDir || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'state');
  const file = path.join(dir, `${name}.lock`);

  // console.log 在无控制台启动时可能抛错，别让它把进程带走
  const say = (msg) => { try { console.log(msg); } catch {} };

  const isFresh = () => {
    try { return Date.now() - fs.statSync(file).mtimeMs < STALE_MS; } catch { return false; }
  };

  // 锁还在心跳期内 → 说明真有实例在跑，让位
  if (isFresh()) {
    say(`[lock] ${name} 已有实例在跑（锁 ${Math.round((Date.now() - fs.statSync(file).mtimeMs) / 1000)}s 前刷新），本进程退出`);
    // 退出码 3 = "已经有人在跑，不是崩溃"。supervisor 看到 3 不会再拉，
    // 否则会形成「每 5 秒起一个注定失败的克隆」的死循环（2026-10-28 实际发生过）。
    process.exit(3);
  }

  // 接管：写自己的 pid，并开始心跳
  const beat = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, String(process.pid));
    } catch {}
  };
  beat();
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  heartbeat.unref?.();

  const cleanup = () => {
    try {
      const cur = Number(fs.readFileSync(file, 'utf8').trim());
      if (cur === process.pid) fs.unlinkSync(file);
    } catch {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  // 热重载：盯着自己的脚本文件，被改了就走 exit(0) 让 supervisor 五秒后
  // 用新代码重启。这样改完不用再手动跑 restart-workers。
  //
  // 注意也要盯 single.mjs 本身：它被所有 worker 共用，改了它（比如判活逻辑）
  // 如果不触发重启，就会一半进程新代码、一半旧代码，很难查。
  try {
    if (!process.env.DSH_NO_HOT_RELOAD) {
      const watched = [];
      const selfPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
      if (selfPath && fs.existsSync(selfPath)) watched.push(selfPath);
      const sharedPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'single.mjs');
      if (fs.existsSync(sharedPath) && !watched.includes(sharedPath)) watched.push(sharedPath);

      if (watched.length) {
        const mt = new Map(watched.map((p) => [p, fs.statSync(p).mtimeMs]));
        const timer = setInterval(() => {
          for (const p of watched) {
            try {
              const m = fs.statSync(p).mtimeMs;
              if (m !== mt.get(p)) {
                say(`[lock] ${name} 检测到 ${path.basename(p)} 更新，退出等待 supervisor 重启`);
                process.exit(0);
              }
            } catch {}
          }
        }, 3000);
        timer.unref?.();
      }
    }
  } catch {}
}
