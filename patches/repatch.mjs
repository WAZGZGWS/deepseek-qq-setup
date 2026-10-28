#!/usr/bin/env node
/**
 * repatch —— 桥接升级后，把本地的几处改动重新打上（幂等）
 *
 * 覆盖的改动：
 *   1) 排队提示开关：`noticeOnQueue !== false`
 *   2) 系统提示静默：`cfg.systemNotices !== false`（5 处）
 *
 * 用法：node repatch.mjs          检查并补丁
 *       node repatch.mjs --check  只检查
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/base.mjs';

const FILE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0', 'src', 'bridge.js');
const CHECK_ONLY = process.argv.includes('--check');

let src = fs.readFileSync(FILE, 'utf8');
const problems = [];

// 1) 排队提示
if (!src.includes('noticeOnQueue !== false')) {
  const needle = "await sendToQQ(key, '\u23f3 \u7cfb\u7edf\u670d\u52a1\u91cd\u542f\u4e2d\uff0c\u6d88\u606f\u5df2\u6392\u961f\uff0c\u6062\u590d\u540e\u81ea\u52a8\u5904\u7406\u3002');";
  if (src.includes(needle)) {
    src = src.replace(needle, needle.replace('await sendToQQ', 'if (cfg.noticeOnQueue !== false) await sendToQQ'));
    problems.push('已补：排队提示开关');
  } else {
    problems.push('⚠️ 排队提示：找不到原文，跳过');
  }
}

// 2) 系统提示静默：逐行处理，已经带门槛的行跳过（幂等）
const sysMarkers = [
  '审批 #${entry.id}',
  '本条回复因疑似包含敏感信息',
  '回答提交失败，请再回复一次',
  '等待回答超时，已取消该请求',
];
let added = 0;
const lines = src.split('\n');
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (!line.includes('await sendToQQ(')) continue;
  if (line.includes('cfg.systemNotices !== false')) continue;
  if (!sysMarkers.some((m) => line.includes(m))) continue;
  lines[i] = line.replace('await sendToQQ(', 'if (cfg.systemNotices !== false) await sendToQQ(');
  added += 1;
}
src = lines.join('\n');
if (added) problems.push(`已补：系统提示静默 ${added} 处`);

const count = (src.match(/cfg\.systemNotices !== false/g) || []).length;
problems.push(`当前 systemNotices 门槛：${count} 处`);

console.log(problems.join('\n'));
if (CHECK_ONLY) process.exit(0);
if (src !== fs.readFileSync(FILE, 'utf8')) {
  fs.writeFileSync(FILE, src);
  console.log('已写入', FILE);
} else {
  console.log('无需改动');
}
