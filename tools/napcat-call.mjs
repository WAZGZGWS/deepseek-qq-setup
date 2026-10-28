#!/usr/bin/env node
/**
 * napcat-call —— 用正确的方式戳一下 NapCat 的 HTTP 接口
 *
 * 为什么需要这个文件：
 *   NapCat 的 HTTP 是**路径式**的，动作名在 URL 上：
 *       POST /get_login_info      body = {}
 *       POST /send_private_msg    body = { user_id, message }
 *
 *   而 OneBot 11 文档里那种「POST / 带 {action, params}」的写法，
 *   这版 NapCat（4.18.41）**不报错，只回一句**：
 *       {"status":"ok","retcode":0,"data":{},"message":"NapCat4 Is Running"}
 *   —— 也就是"假装成功，其实什么都没做"。
 *
 *   2026-10-28 就因为这个问题，机器人以为自己在 QQ 空间发了说说，
 *   实际上一个字都没发出去，而且日志里全是 ok。
 *
 * 用法：
 *   node napcat-call.mjs get_login_info
 *   node napcat-call.mjs get_status
 *   node napcat-call.mjs send_private_msg '{"user_id":123456,"message":"测试"}'
 *   node napcat-call.mjs send_qzone_msg '{"content":"测试","ugc_right":16,"target_uins":["123456"]}'
 *
 * 环境变量 NAPCAT_HTTP 可改地址，默认 http://127.0.0.1:3000
 */

const BASE = (process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const action = process.argv[2];
const rawArgs = process.argv[3] || '{}';

if (!action) {
  console.error('用法: node napcat-call.mjs <动作名> [JSON参数]');
  console.error('例子: node napcat-call.mjs get_login_info');
  process.exit(1);
}

let params;
try {
  params = JSON.parse(rawArgs);
} catch (e) {
  console.error('参数不是合法 JSON: ' + e.message);
  process.exit(1);
}

const url = `${BASE}/${action}`;
console.log(`POST ${url}`);
console.log(`body ${JSON.stringify(params)}`);

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  console.log(`HTTP ${res.status}`);
  console.log(text.slice(0, 2000));

  // 关键判断：这版 NapCat 对不认识的请求会回 "NapCat4 Is Running" 且 data 为 {}。
  // 看到这句就当失败，别被 status:ok 骗了。
  if (json && typeof json.message === 'string' && json.message.includes('NapCat4 Is Running')) {
    console.error('\n⚠ 这个响应说明动作**没有被执行**：');
    console.error('  NapCat 只回了一句 "NapCat4 Is Running"，data 是空的。');
    console.error('  检查动作名拼写，或者确认这版 NapCat 是否支持该动作。');
    process.exit(2);
  }
  if (json && (json.status === 'failed' || (typeof json.retcode === 'number' && json.retcode !== 0))) {
    console.error('\n✗ NapCat 明确报错：' + (json.message || json.wording || 'retcode=' + json.retcode));
    process.exit(3);
  }
  console.log('\n✓ 调用成功');
} catch (e) {
  console.error('调用异常: ' + e.message);
  process.exit(4);
}
