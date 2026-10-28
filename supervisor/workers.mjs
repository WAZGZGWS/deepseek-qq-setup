import path from 'node:path';

/**
 * 后台工人名单 —— 全项目只此一份。
 *
 * supervisor 照它启动，stack-doctor 照它数心跳。
 * 以前两边各写一份：加了 eye-drop 之后 supervisor 那份改了、doctor 那份没改，
 * 于是 doctor 只数 7 个锁，eye-drop 死了也报「全部在跑」。
 * 名单放这里，两边 import，改一次就都改了。
 */
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

export const WORKERS = [
  { name: 'cron', file: path.join(ROOT, 'cron', 'cron.mjs') },
  { name: 'archive', file: path.join(ROOT, 'archive', 'collector.mjs') },
  { name: 'eye-drop', file: path.join(ROOT, 'eye-drop', 'eye-drop.mjs') },
  { name: 'janitor', file: path.join(ROOT, 'session-janitor', 'session-janitor.mjs') },
  { name: 'budget', file: path.join(ROOT, 'budget-guard', 'budget-guard.mjs') },
  { name: 'balance', file: path.join(ROOT, 'balance-watch', 'balance-watch.mjs') },
  { name: 'context', file: path.join(ROOT, 'context-guard', 'context-guard.mjs') },
  { name: 'power', file: path.join(ROOT, 'power-guard', 'power-guard.mjs') },
];

/** 只要名字（stack-doctor 数 state/<name>.lock 用） */
export const WORKER_NAMES = WORKERS.map((w) => w.name);
