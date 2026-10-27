# QQ Bot Stack

把 DeepSeek Harness 变成一个**能长期跑下去**的 QQ 机器人所必需的那一层：记忆、会话轮换、进程守护、自检、告警。

> **这不是一个开箱即用的机器人。**
> 人设（角色卡）本项目**不提供**——你的角色是什么性格，得你自己写。见 [`roles/README.md`](roles/README.md)。
> 这里提供的是"让她稳定跑一个月不崩、不忘事、不偷偷烧钱"的那套运维代码。

## 它解决什么问题

跑过 QQ 机器人都知道，真正的痛点不是"接上 QQ"，而是接上之后：

| 问题 | 这套东西怎么处理 |
|---|---|
| 聊久了上下文越滚越大，一天烧 7 块钱 | `context-guard`：超 32k 换会话，换之前把记忆和最近 20 句对话交接过去 |
| 换会话就失忆 | 四层记忆：长期事实 / 随身本 / 每日摘要 / 完整档案 |
| 进程不知道什么时候就死了 | `supervisor` 管 7 个 worker，`stack-guard` 管 supervisor 和桥接 |
| 改了代码要手动重启 | 心跳锁 + 热重载，改文件 3 秒生效 |
| 出问题没人知道 | `self-check` 每天自查，`notify` 推手机 |
| 余额耗尽了才发现 | `balance-watch` 每 30 分钟查一次 |

## 架构

```
QQ 客户端
   ↕
NapCat (:3000 HTTP / :3001 WS)          ← QQ 协议层，需要 UAC 提权
   ↕
qq-bridge (:3100 控制台)                 ← 把 QQ 消息接到 DSH
   ↕
DeepSeek Harness                        ← 真正说话的那层

旁路：
  supervisor   管 7 个后台脚本，崩了重启
  stack-guard  守护 supervisor 和桥接
```

## 前置要求

- **Windows 10/11**（脚本用的是 PowerShell + Node，Linux 需要自己改路径分隔符）
- **Node.js 20+**
- **DeepSeek Harness 桌面版**（提供 Web GUI 和 API）
- **NapCat Shell**（QQ 协议层）
- 一个 **QQ 小号**（用大号有封号风险，自己权衡）
- **7-Zip**（可选，用于加密备份）
- **DeepSeek API key**

## 部署

### 1. 装 NapCat

1. 从 [NapCatQQ releases](https://github.com/NapNeko/NapCatQQ/releases) 下载 Shell 版
2. 解压到 `E:\qq-bot-stack\napcat\`
3. `launcher.bat` 需要管理员权限（它要注入 QQ 进程）

**免扫码登录**：启动时带 `-q 你的QQ号`，NapCat 会复用本地凭证跳过二维码。

```bat
call launcher.bat -q 123456789
```

### 2. 装 DSH + 桥接

见 [dsh-qq-bridge](https://github.com/h-D-ACE/dsh-qq-bridge) 的说明。

关键配置（`config.json`）：

```json
{
  "ownerQQ": YOUR_QQ,
  "allow": { "private": ["YOUR_QQ"], "groups": [] },
  "socialV2": {
    "wake": { "defaultMode": "active", "recommendedProbability": 0.7 },
    "tools": { "sendGroup": false, "reply": false, "listGroups": false }
  }
}
```

`allow.private` 只放你自己的号，群列表留空（本项目只做私聊）。

### 3. 部署本套件

把本仓库放到 `E:\qq-bot-stack`（或任意位置，但要改 `cron` 里的路径假设）。

```powershell
# 依赖
cd E:\qq-bot-stack
npm init -y     # 如果你要用到 node_modules 里的东西
```

### 4. 写人设

**这是最费时间的一步**，见 [`roles/README.md`](roles/README.md)。

### 5. 起服务

```
1-启动NapCat.bat        ← 手动点，过 UAC
2-启动桥接.bat          ← 或让 stack-guard 自动拉起
20-supervisor.bat       ← 管后台脚本
```

## 脚本清单

| 脚本 | 频率 | 作用 |
|---|---|---|
| `supervisor` | 常驻 | 管 7 个 worker，崩溃 5 秒后重启 |
| `stack-guard` | 常驻 | 守护桥接 + supervisor |
| `stack-doctor` | 每 2 分钟（计划任务） | 全栈体检：QQ / 桥接 / DSH / 后台脚本，谁挂了拉谁 |
| `like-card` | 每天 09:30 | 给主人名片点赞（纯 API，不花 token） |
| `context-guard` | 每 3 分钟 | 上下文超 24k 换会话（34k 缩短等待，46k 强制） |
| `memory-tidy` | 每天 22:20 | 合并重复、压缩冗长、清过期话题（长期事实一条不丢） |
| `memory-summary` | 每天 23:10 | 生成当日摘要（跨天去重） |
| `self-check` | 每天 21:20 | 自查 + 自动清僵尸锁 |
| `archive` | 每 60 秒 | 归档聊天到 `archive/logs/YYYY-MM-DD.md` |
| `session-janitor` | 每 60 分钟 | 清理闲置会话 |
| `budget-guard` | 每 30 分钟 | 超预算进省电模式 |
| `balance-watch` | 每 30 分钟 | 余额四档提醒（带充值链接）、余额越低说话越少、静默时段不发 |
| `power-guard` | 每 60 秒 | 断电/睡眠前存档 |
| `cron` | 每 30 秒 | 调度上面这些定时任务 |
| `notify` | 按需 | 外部告警出口 |

## 关键设计

### 记忆四层

```
长期事实   facts[]     只增不删，30 条上限      作息、口味、忌口、重要日期
随身本     话题+印象    14 天 TTL               正在聊的、对某人的印象
每日摘要   3~4 条/天    保留 90 天，注入 4 天     "昨天聊了什么"
完整档案   每句话       永久                    chat_search 全文检索
```

**为什么分四层**：话题会被 TTL 清、印象只有名额、摘要 90 天清一次——只有 `facts` 能保证"聊半年也记得你几点睡"。

> 注意：`facts` 要同时出现在**五个地方**才不丢——保存白名单、加载、清理、轮换恢复、断电恢复。本项目已经全部处理，你自己改的时候留意。

### 心跳锁

```
每个 worker 每 20 秒刷新自己的 .lock 文件 mtime
新实例启动时：锁 90 秒内被刷新过 → 让位；否则接管
```

**为什么不用 pid**：Windows 会把 pid 复用给别的进程，只看 pid 会变成僵尸锁。
**为什么不用 wmic 查命令行**：Win11 已经移除 wmic。

### 热重载

worker 每 3 秒检查自己的脚本和 `single.mjs` 的 mtime，变了就 `exit(0)`，supervisor 5 秒后用新代码重启。

## 踩坑记录

这些都是实际踩过的，写下来省你时间：

| 坑 | 现象 | 解法 |
|---|---|---|
| **环境变量里的旧 API key** | 余额告警/日报/联网搜索全部静默 401，但进程"正常" | 脚本改成**文件优先**，不信任环境变量 |
| **`wmic` 在 Win11 不存在** | 用 wmic 查命令行的判活逻辑退化成"只要是 node 就算"，锁死 | 改心跳判活 |
| **`console.log` 在无控制台时抛错** | supervisor 用 `Start-Process` 启动几秒后静默死 | `log()` 里包 try/catch |
| **`save/load` 白名单不对等** | 新字段内存里有、落盘就没了 | 两边都要加 |
| **`String(对象)` = `[object Object]`** | 记忆里出现脏条目 | 入口处拒绝 object 类型的 content |
| **pid 复用** | 锁指向已死的进程，但检测说"活着" | 心跳 |
| **计划任务返回 -1073741510** | NapCat 自启失败（控制台被关） | 只能手动点 UAC |
| **`.bat` 里写中文注释** | 脚本"闪一下就没了"，cmd 报语法错误 | `.bat` 全用 ASCII，中文放到 `.ps1`（UTF-8 带 BOM） |
| **提权进程写不进桥接的 state 目录** | 守护脚本说"已拉起"，`3100` 却永远是空的（桥接在 `bridge.lock` 上 `EPERM` 退出） | 那个目录带 Low 完整性标签。用 `explorer.exe <脚本>` 代开，权限退回普通用户就写得进去了 |
| **进程活着、端口在听、消息不处理** | 你发消息她一个字不回，端口和进程检查全部正常 | 对账：NapCat 日志里"收到私聊"的时间 vs 桥接记录的 `lastIncomingAt`，差 5 分钟以上就重启桥接 |
| **余额提醒半夜发消息** | 凌晨被"钱快没了"吵醒 | 提醒是脚本直连 NapCat 发的，绕过了桥接静默。脚本里要自己判断静默时段 |

## 自检

```powershell
node self-check/self-check.mjs          # 只报
node self-check/self-check.mjs --fix    # 能修的自动修
```

检查四项：API key 一致性、worker 重启循环、记忆一致性、出戏检测。

**建议加进 cron**（本项目已默认 21:20 执行）。

## 全栈体检（stack-doctor）

每 2 分钟跑一次，跑完就退。检查四层，谁挂了拉谁：

| 检查项 | 判断方式 | 挂了怎么办 |
|---|---|---|
| QQ（NapCat） | `POST :3000/get_login_info` 有没有 `user_id` | `launcher.bat -q QQ号` 快速登录 |
| 桥接 | `:3100` 能不能连上 | 重新拉起启动脚本 |
| 桥接"假活" | NapCat 日志的"接收"时间 vs 桥接的 `lastIncomingAt` | 调 `/api/restart` 重启 |
| DSH 本体 | `tasklist` 里有没有 `DeepSeek Harness.exe` | 直接启动 exe |
| 后台脚本 | 7 个 worker 锁有几个是新鲜的（5 分钟内） | 重新拉起 supervisor |

**为什么用计划任务而不是常驻进程**：常驻进程有"活着"这个状态，所以它会死，而且死了没人知道（实测：看门狗 09:00 自己死了，13:33 QQ 掉线后 7 小时无人处理）。一次性脚本没有"活着"这个状态，也就死不了。

**为什么用 `explorer.exe` 启动桥接**：计划任务要提权（拉起 NapCat 必须），但桥接的 `state` 目录带 Low 完整性标签，高权限进程写不进去。`explorer.exe` 是已登录用户的 shell，由它代开就退回普通权限。

注册（管理员 PowerShell，按需改路径）：

```powershell
$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "E:\qq-bot-stack\stack-doctor\run.cmd"' -WorkingDirectory 'E:\qq-bot-stack'
$logon   = New-ScheduledTaskTrigger -AtLogOn
$repeat  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
$set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$who     = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName 'QQStackDoctor' -Action $action -Trigger @($logon,$repeat) -Settings $set -Principal $who -Force
```

启动脚本的名字如果和默认不一样，用环境变量覆盖，不用改代码：

```
NAPCAT_BOOT_BAT   napcat-boot.bat
BRIDGE_BAT        2-启动桥接.bat
SUPERVISOR_BAT    20-supervisor.bat
```

**它不会往聊天里发任何东西**——恢复日志只写文件和弹窗。让她说话只能由她自己说。

## 告警

编辑 `notify.json`：

```json
{ "enabled": true, "type": "dingtalk", "webhook": "https://oapi.dingtalk.com/robot/send?access_token=xxx" }
```

支持 `json` / `bark` / `dingtalk`。**没配 webhook 时消息会写进 `state/notify-pending.log` 排队，不是丢弃。**

## 目录结构

```
./
├── archive/          聊天归档
├── balance-watch/    余额监控
├── bridge-reload/    桥接重载
├── budget-guard/     预算保护
├── context-guard/    上下文轮换
├── cron/             定时器
├── daily-report/     每日报表
├── like-card/        名片点赞（0 token）
├── lock/             心跳单例锁
├── maintenance/      日志轮转 + 备份
├── memory-summary/   每日摘要
├── memory-tidy/      记忆整理
├── notify/           告警出口
├── patches/          补丁自检
├── power-guard/      断电保护
├── regression/       回归测试
├── roles/            人设（自己写）
├── self-check/       自查
├── session-janitor/  会话清理
├── stack-doctor/     全栈体检（每 2 分钟）
├── stack-guard/      整链守护
├── supervisor/       进程总管
└── versions/         版本快照
```

## 更新与推送

改完代码后：

```powershell
cd <本仓库目录>
git add -A
git commit -m "说明你改了什么"
git push
```

**改了什么容易忘**：路径和账号不是写在一处的，动过之后记得同步：

| 改了什么 | 要同步的地方 |
|---|---|
| 部署目录 | `cron/cron.mjs` 顶部的绝对路径 |
| QQ 号 | `config.json` 的 `ownerQQ` / `allow.private` |
| 人设文件名 | `roles/` 下的文件（回归测试会自动发现，但路径别写死） |

## GitHub 推送常见故障

国内网络推 GitHub 经常会撞上这几个，照着处理：

| 报错 | 原因 | 解法 |
|---|---|---|
| `schannel: next InitializeSecurityContext failed: CRYPT_E_NO_REVOCATION_CHECK (0x80092012)` | 网络里有代理/安全软件拦了 github.com，证书吊销列表拉不到 | `git config --global http.schannelCheckRevoke false`；还不行再加 `git config --global http.sslVerify false` |
| `Repository not found` | 仓库还没建，或者名字拼错 | 先在 GitHub 建**空仓库**，别勾 README / .gitignore / license |
| `Permission to USER/REPO.git denied` / `403` | token 没有写权限 | 用 classic token，**必须勾 `repo`**；Fine-grained token 要把 `Contents` 设成 Read and write |
| `fatal: 此平台上不支持操作` | Git Credential Manager 存不下凭据（便携版 git 常见） | `git config --local credential.helper ""` 然后 `git config --local --add credential.helper store`，改用 token 认证 |
| 一直停在 `Waiting for your browser` | 浏览器授权没回到终端 | 直接带 token 推：`git push https://用户名:TOKEN@github.com/用户/仓库.git main` |

**token 不要留在配置里**：用带 token 的临时地址推完，立刻改回干净地址——

```powershell
git remote set-url origin https://github.com/用户/仓库.git
```

## License

MIT
