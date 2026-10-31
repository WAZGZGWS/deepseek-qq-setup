# 已知问题与解决办法

症状 → 原因 → 办法。遇到没列在这里的，先看 `state/` 下的日志：`blackbox.jsonl`、`medic.log`、`brain.log`、`eye.log`。

## 登录 / 封号

**刚登上就被踢**：两条路径同时拉 QQ，互相顶号。→ 只从 `tools/napcat-start.mjs` 启动；先 `taskkill /IM QQ.exe /T /F` 再拉；巡检和计划任务不要再直接调 launcher.bat。

**二维码刚扫就失效**：同时发起了两次登录；或轮询遇到"已过期"就退出。→ 同一时间只允许一次登录；遇过期要 `RefreshQRcode` 后继续等；密码登录前先刷新。

**掉线一整天没人救**：验证要人工 + 退避太久。→ 45 分钟一轮、每天最多 3 次、23:00–07:00 不试、链接过期自动再发（每天最多 6 封）、预算用尽主动下线。

**验证码 / 识图验证 / 一直"安全检测中"**：风控升级，非官方协议端过不去。→ **停手**，等人工验证。本项目不提供任何绕过手段。

**提权后拉不起 QQ**：管理员身份会和用户会话里的 QQ 冲突。→ 用登录用户身份启动（`napcat-start --as-user`）。

## 进程 / 自愈

**巡检说"已拉起"但 QQ 没起来**：`napcat-start` 因"QQ 已在跑"被护栏拒绝（这是故意的）。→ 先清旧 QQ 再拉。

**主脑和旧 supervisor 各拉一套 worker**：状态显示全停、机器上却在跑；日志大量"锁冲突退出"。→ 主脑占住 `supervisor.lock`，旧 supervisor 起来即退出码 3；启动脚本见退出码 3 直接退，不要 5 秒重试。

**急救员误报"主脑挂了"**：重试几十秒就满了。→ 只在"连续断满 5 分钟且最近 2 分钟没活过"时发信；改代码重启主脑时忽略。

**急救员清场把桥接杀了**：按后缀清了所有 `*.lock`。→ 只清 `supervisor/workers.mjs` 名单里的 worker 锁，本体锁一律不碰。

**器官互相踩（谁后写谁赢）**：省聊被改回去、主动发言忽开忽关。→ 省钱优先：生物钟见 `cerebellum-policy.json` 是 `proactive=off` 就不动桥接；新器官默认只读，要 `tools/organ-mode.mjs <器官> active`。

## 扫码页 / 黑屏

**7788 被旧进程占住**：EADDRINUSE 且 taskkill 无效。→ 换端口 `qr-live.mjs --port=7790`，`qr-screen.mjs` 会自动找带 `/hits` 的端口。

**脚本拉浏览器窗口没出来**：浏览器把窗口交给已有实例、启动器立刻退出。→ 黑屏用 WinForms（`tools/qr-black.ps1`），用心跳文件确认真的亮起来。

**PowerShell 报"意外的标记"**：PS 5.1 读无 BOM 的 UTF-8 按 ANSI 解析，中文标点把解析器搞崩。→ `.ps1` 存 UTF-8 with BOM，更稳是纯 ASCII；`.bat` 同样只用 ASCII。

**PS 事件处理器里变量是空的**：事件是另一个作用域。→ 用 `$script:` 前缀，或用 `Show()` + `DoEvents()` 循环。

**查不到进程命令行/父进程**：wmic 已移除、某些进程 CIM 查不到。→ 用 `tasklist /FO CSV`；杀进程前核对镜像名，Windows 会复用 pid。

## AI / 工具

**新加 MCP 工具没生效**：工具挂在 DSH profile（`cordis.patch.yml`），不在桥接 `config.json`。→ 追加挂载（别动已有的），重启后 `qq_get_prompt` 看工具表，没有就回滚那一行。

**邮件太频繁**：耳朵只回白名单指令、每天最多 6 封；急救员每类告警每小时最多 1 封。

**余额掉太快**：按档位收敛（<5 降概率、<2 关主动、<1 只回话）；`treasurer` 提前 3 小时降档；`tools/autonomy-check.mjs paid` 当闸门。

## 发布 / 仓库

**`git push` 连不上**：换网络/开代理；token 不要写进 remote URL（会留在 `.git/config`），用凭据管理器；token 曾出现在日志/截图里要立刻撤销重发。

**公开前**：跑 `node tools/sync-check.mjs --live <部署目录> --repo <仓库>` 做泄漏扫描；确认 `config.example.json` 全是占位符；删掉 `roles/`、`state/`、`chat-memory/`、`archive/`；读 `HANDOVER.md` 的风险清单；许可是 PolyForm Noncommercial（非 OSI 开源）。

## 还是不行

按顺序翻：`blackbox.jsonl`（每 20 秒快照，谁先坏、何时坏）→ `medic.log`（救过几次、怎么救）→ `brain.log` / `brain-decisions.jsonl`（主脑的决定）→ `eye.log` / `eye-report.json`（谁死了、谁摸鱼）。