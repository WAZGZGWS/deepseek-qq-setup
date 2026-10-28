# QQ Bot Stack

> 分享给那些愿意和我一样折腾的人。

把 DeepSeek Harness 变成一个**能长期跑下去**的 QQ 机器人所必需的那一层：记忆、会话轮换、进程守护、自检、告警。

> **这不是一个开箱即用的机器人。**
> 人设（角色卡）本项目**不提供**——你的角色是什么性格，得你自己写。见 [`roles/README.md`](roles/README.md)。
> 这里提供的是"让她稳定跑一个月不崩、不忘事、不偷偷烧钱"的那套运维代码。

## 💰 完全免费 · 有人向你收费就是骗子

这个仓库**永久免费**，用的是 **PolyForm Noncommercial 1.0.0**：自己用、改、分享给朋友都随便，**唯独不许商用**。

**如果你是在任何地方花钱买到它的：**

1. **立刻停止付款**；已经付了的，要求对方原路退回
2. 在购买的平台**举报那个卖家**（卖免费开源代码属于欺诈）
3. 回到这里拿正版：`https://github.com/WAZGZGWS/deepseek-qq-setup`

对方卖给你的东西，在这个地址是免费的。你付的钱一分都没到作者手上。

**代码直接拿去用就行**，不用问我，也不用署名。

唯一的限制：**别商用**。自己用、改、再分享给朋友，都随便；拿它去卖钱、打包成付费教程、塞进收费产品里，不行。

觉得有用就打赏 **1~5 元**（完全自愿，不打赏照样能用全部功能）：

<p align="center">
  <img src="donate/qr.png" width="220" alt="打赏二维码">
  <br>
  <sub>谢谢给的 token</sub>
</p>

<sub>（图片没显示出来？点这里看原图 → [`donate/qr.png`](donate/qr.png)）</sub>

> 这不是"请求"，是**协议条款**：PolyForm Noncommercial 1.0.0 明确只授权非商业用途。
> 商业使用（拿去卖、打包成付费服务、放进收费产品）没有授权。
> 想商用请先联系作者单独谈授权。

> 为什么只收 1~5 块：这套东西解决的是"自己折腾"的问题，不是一件商品。给个几块钱是"我用了，谢谢"，不是"我买了"。

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

## 别人下载下来能直接用吗

**能，但你得先把下面四样装好**——这个仓库只提供「运维那一层」，不含机器人本体。

| 需要你自己准备 | 为什么仓库里没有 |
|---|---|
| **Node.js 20+** | 运行时依赖，自己装更安全 |
| **DeepSeek Harness 桌面版** | 商业桌面应用，不能分发 |
| **NapCat Shell** | 要你自己扫码登录 QQ |
| **桥接 dsh-qq-bridge** | 独立项目，本仓库只调它的接口 |
| **一个人设** | `roles/README.md` 有模板，性格得你自己写 |

装好之后跑 `install.cmd`，它体检时会告诉你还缺哪个。

### 已经处理掉的「换台电脑就坏」

这几处原来写死在我们自己机器上，现在都改成自适应的：

| 原来会坏的地方 | 现在 |
|---|---|
| 启动器里写 `node ...`，计划任务没有用户 PATH → 找不到 node | install 时解析 `node.exe` 绝对路径写进去 |
| `CHAT_KEY` 默认 `private:YOUR_QQ`，不手改就发错人 | 自动从桥接 `config.json` 的 `ownerQQ` 推出来 |
| NapCat 日志固定找 `<root>\napcat\napcat\logs` | 可用 `NAPCAT_DIR` 覆盖 |
| 启动脚本名字固定（`2-启动桥接.bat` 等） | `NAPCAT_BOOT_BAT` / `BRIDGE_BAT` / `SUPERVISOR_BAT` 可覆盖 |
| 中文直接写进 `.bat` → GBK 尾字节撞上 `|` `^` `&` 把命令拆断 | `.bat` 全 ASCII，中文放 `risk-notice.ps1` |

### 还是会有落差的地方

| 落差 | 说明 |
|---|---|
| **只有 Windows** | 脚本用 PowerShell + `netstat` + 计划任务，Linux 要重写 |
| **绑定了桥接的接口** | `dsh-qq-bridge` 的 `/api/socialV2/*`、`config.json` 字段名变了就要跟着改 |
| **默认目录结构** | 期望 `<root>/dsh-qq/qq-bridge-enhanced-v1.1.0/`，桥接换个名字要改常量 |
| **中文界面** | 提示都是中文，非中文 Windows 下 `.ps1` 可能显示乱码（功能不受影响） |
| **计划任务要登录** | 没开自动登录的话，重启后要有人登录才会自愈 |
## 前置要求

- **Windows 10/11**（脚本用的是 PowerShell + Node，Linux 需要自己改路径分隔符）
- **Node.js 20+**
- **DeepSeek Harness 桌面版**（提供 Web GUI 和 API）
- **NapCat Shell**（QQ 协议层）
- 一个 **QQ 小号**（用大号有封号风险，自己权衡）
- **7-Zip**（可选，用于加密备份）
- **DeepSeek API key**

## 部署

### 0. 一键部署（先跑这个）

双击仓库根目录的 **`install.cmd`**（会提权一次），流程是：

**① 先体检这台电脑**：系统版本、CPU、内存、每个盘的剩余空间、UAC 级别、快速启动状态、已装组件（Node / DSH / 7-Zip）。哪项不达标当场说，不往下走。

**② 问安装位置（只问第一次）**：选好的目录记在

```
%LOCALAPPDATA%\qq-bot-stack\install.json
```

之后每次运行都读这条记录，**所有东西继续装到同一个位置**。要换位置，在提示里直接输新路径，或者加 `-Reset` 重新问。

**③ 复制 + 生成 + 注册**：脚本复制过去，按你填的 QQ 号生成启动器，注册「全栈体检」计划任务（每 2 分钟自愈），关掉自动睡眠和快速启动。

**④ 依次启动**：装完问你要不要现在启动，按 NapCat → 等 `:3000` 通 → 桥接 → 等 `:3100` 通 → supervisor 的顺序走，每一步都等端口真的通了才走下一步。

**生成的启动器会先打印风险提示**（封号风险 / 隐私 / 计费 / 不含人设 / 要一直开机），你输入 N 就不启动。无人值守调用时加 `-y` 跳过提示——守护脚本就是这么调的。

> 为什么风险提示不在 `.bat` 里写中文：GBK 汉字的尾字节会落在 `|`、`^`、`&` 这些 cmd 元字符上，把一行 `echo` 拆成两条命令，直接报错。中文一律放在 `risk-notice.ps1`（UTF-8 带 BOM），`.bat` 保持纯 ASCII。

**它不会装** Node、DSH、NapCat、桥接——这四样都得你自己装好，缺什么它会直接说缺什么，装完再跑一次即可。

命令行用法：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -TargetDir D:\qq-bot-stack -OwnerQQ 123456789 -BotQQ 987654321

# 只看不改
powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun

# 忘掉记住的位置，重新问
powershell -ExecutionPolicy Bypass -File install.ps1 -Reset
```

### 1. 装 NapCat

1. 从 [NapCatQQ releases](https://github.com/NapNeko/NapCatQQ/releases) 下载 Shell 版
2. 解压到 `E:\qq-bot-stack\napcat\`
3. `launcher.bat` 需要管理员权限（它要注入 QQ 进程）

**免扫码登录**：启动时带 `-q 你的QQ号`，NapCat 会复用本地凭证跳过二维码。

```bat
call launcher.bat -q 123456789
```

> **NapCat 的 HTTP 接口是路径式**：`POST /动作名`，参数直接当 body。
> 不要写成 OneBot 文档里那种 `POST /` 带 `{action, params}` —— 这版 NapCat 会回一句
> `{"status":"ok","data":{},"message":"NapCat4 Is Running"}`，**看起来成功，其实什么都没做**。
> 不确定就用 `node tools/napcat-call.mjs get_login_info` 试一下。

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
| `eye-drop` | 常驻（每分钟） | 按「主人当天第一句话」的时间排滴眼药水提醒（见下） |
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
| **档案只记了一方** | 文件在、行数在涨、`chat_search` 却搜不到对方的话 | 消息去重用的 key 是 `s<seq>`，而 `seq` **每个会话/每次桥接重启都从 1 重新数**，今天的 `s3` 和昨天的 `s3` 撞车，于是全被当成"已归档"。key 里必须拼上时间戳：`s<seq>@<time>` |
| **锁冲突被当成崩溃** | supervisor 每 5 秒起一个注定失败的克隆，日志刷屏 | 让位时用 **退出码 3**，supervisor 看到 3 就不再重启，改成 60s/120s/180s 退避 |
| **明文备份和加密包并排放在云上** | 加密做了，但同目录还有一份明文，等于没加密 | 云上只放 `.7z`；明文目录只留本地，并定期清理云上的历史明文 |
| **日志只写了 console** | 被守护进程拉起时 `stdio=ignore`，出事了查不到任何记录 | 所有常驻/定时脚本的 log 必须落文件，不能只 `console.log` |
| **Wi-Fi 网卡省电** | 每天固定时间掉线，掉了就得扫码 | 网卡"允许计算机关闭此设备"要在夜里断开连接。设 `PnPCapabilities=24` 关掉（见 `tools/`） |
| **拿 0 当时间戳比大小** | 日志出现"29885746 分钟前收到过消息" | 桥接还没收到过消息时 `lastIncomingAt` 是 0，相减等于"从 1970 年到现在"。比之前先判非零 |
| **NapCat 的接口是路径式，打 `/` 会拿到假 ok** | 说"已发布"，打开空间却什么都没有；日志里全是 `status: ok` | 正确写法是 `POST /动作名` + 参数当 body。写成 `POST /` 带 `{action,params}` 时，这版 NapCat 只回一句 `NapCat4 Is Running`，`data` 是空的——**动作根本没执行**。用 `tools/napcat-call.mjs` 验证 |

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

## 说说只给自己看

QQ 空间的默认可见范围是**公开**。私人小号发的日常，会出现在所有人（或全部好友）的动态里，不合适。

发之前显式指定：

```
send_qzone_msg { content, ugc_right: 16, target_uins: ["主人的QQ"] }
```

- `ugc_right: 16` = 指定好友可见，配合 `target_uins` 就变成"只有这个人能看到"
- `ugc_right: 1` = 公开（默认）
- `ugc_right: 64` = 仅自己（连主人都看不到，一般不用）

2026-10-28 实测确认：设成 16 + 主人 QQ 之后，主人在自己空间的好友动态里能看到，别人看不到。

> 注意：`send_qzone_msg` 的返回里 `tid` 是**唯一能删掉这条说说的凭据**。
> 如果响应里 `data` 是空的（例如走错了接口路径），说明根本没用发出，别把它当成成功。

## 提醒跟着人来（eye-drop）

固定的 `07:05 / 07:10 / 07:15` 三条滴眼药水任务有个毛病：**人 9 点才醒，提醒 7 点就全发完了**。

现在改成按「主人当天第一句话是几点」来排：

```
1. 每分钟看一眼今天的聊天档案，找出主人今天发的第一句话
2. 只认 04:00~12:00（更晚就不提醒了）
3. 那一刻 +2 / +7 / +12 分钟，各建一条**一次性**的 AI 提醒任务
4. 一天只排一次，记在 state/eye-drop.json
```

**为什么要用一次性任务**：固定任务每天都会在同一个点响。今天按 8:12 排，明天 8:12 就先响一次，而那时人可能还没醒。一次性任务只用一天，第二天重新按当天的醒来时间排。

**它依赖聊天档案**——档案只记一方的话，它就永远排不上。所以 `self-check` 里那条「档案完整性」检查是它的前置条件。

## 告警

编辑 `notify.json`：

```json
{ "enabled": true, "type": "dingtalk", "webhook": "https://oapi.dingtalk.com/robot/send?access_token=xxx" }
```

支持 `json` / `bark` / `dingtalk`。**没配 webhook 时消息会写进 `state/notify-pending.log` 排队，不是丢弃。**

## 能做到什么 · 做不到什么 · 会出什么问题

### 一、它能做到的

| 能力 | 具体表现 |
|---|---|
| **四层记忆，跨会话不丢** | 长期事实（只增不删）+ 随身本（14 天）+ 每日摘要（永久）+ 完整档案 |
| **翻旧账真能翻到** | 档案双向归档（双方的话都记），`chat_search` 能搜到对方说过什么 |
| **换会话不失忆** | 超阈值换新会话时，交接记忆快照 + 最近 20 句 |
| **说话像人** | 分条发、有口癖、会抱怨、会主动找你 |
| **提醒跟着人来** | 不定死时间，按「对方当天第一句话」推算（见 `eye-drop`） |
| **省钱有纪律** | 上下文超线自动换、余额越低说话越少、主动开口按概率克制 |
| **掉线能自愈** | 见下面第三节 |
| **不把运维说词漏进聊天** | 角色卡硬禁「掉线/重启/余额/接口」，脚本也不往聊天发通知 |

### 二、天生做不到的

| 做不到 | 原因 |
|---|---|
| 看懂图片 | 只能知道「有张图」，看不到内容 |
| 发语音 | 要自备语音库 |
| 接微信 | 没有可用协议端 |
| 读懂视频/图片类内容 | B 站、知乎只能拿文字 |
| 长对话永远记得细节 | 上下文有硬上限，换会话后早期的玩笑会模糊 |
| 绝不瞎编 | 模型通病 |
| 成本不随聊天量涨 | 每句话都要重算一遍上下文 |
| 跨平台 | 只做 QQ |

### 三、出问题时的自愈能力

| 问题 | 谁来管 | 恢复时间 |
|---|---|---|
| QQ 被踢下线（票据还有效） | `stack-doctor` | 4 分钟内快速登录 |
| QQ 进程挂了 / 电脑重启 | `stack-doctor` | 3 分钟内 |
| 桥接进程死了 | `stack-doctor` | 2 分钟内 |
| 桥接「假活」（端口在、消息不处理） | `stack-doctor` 对账检测 | 4~6 分钟 |
| DSH 被关掉 | `stack-doctor` | 2 分钟内 |
| 后台脚本死了 | `supervisor` + `stack-doctor` | 2 分钟内 |
| 锁被老进程占着 | `lock/single.mjs` 判活 | 立刻 |
| 记忆写坏了 | `memory-tidy` 写后对账 | 当场回滚 |
| 上下文烧太快 | `context-guard` | 超线即换 |

### 四、必须人来做的

| 问题 | 说明 |
|---|---|
| **登录票据彻底失效** | 只能扫一次码，远程桌面 + QQ「扫一扫从相册选图」可以自己救 |
| 余额耗尽 | 提醒会到，但充钱只能人来做 |
| 断电 / 死机 | 来电后能自动登录，但得有人在机器旁 |
| 家里断网 | 无解 |

### 五、几个「不算 bug，但你得知道」的

1. **定时任务会被「会话繁忙」延后**：对方正在连发消息时，早安/晚安会排队，等回合结束才执行，密集聊天时可能被后一轮吃掉。
2. **上下文实际均值远高于阈值**：守门员要等回合结束才换会话，聊得密就等不到，实测均值能到阈值的 1.5 倍。
3. **记忆压短靠模型**：每天一次，要求条数不变、只能变短，失败就用原文——但仍可能把某句话的措辞改掉。
4. **档案水位有时间差**：换会话或重启瞬间的几条消息可能漏归档。
5. **`.bat` 里不能直接写中文**：GBK 汉字的尾字节可能撞上 `|` `^` `&`，把一行命令拆断。

### 六、修不了的

腾讯判违规封号、腾讯改协议、网络中断、成本线性增长——这些是「非官方协议端」的固有代价，不是代码能解决的。

## 常见问题

**她不回我话，第一步查什么？**

按这个顺序，基本三分钟能定位：

```
1. node state/stack-doctor.log        最后几行在说哪个组件挂了
2. netstat -ano | findstr ":3000 :3100"   端口在不在
3. 余额查一下                          是不是没钱了（她会提前提醒四档）
```

如果是"端口都在、消息也收到了但就是不回"，看 `stack-doctor.log` 有没有「判定假活」——那是桥接卡住了，守护脚本会在 4~6 分钟内重启它。

**她会说自己是 AI 吗？**

不会主动说。角色卡里写死了：只有你直接问、且反复追问时才承认，平时任何情况下不提模型、程序、API 这类词。

**能多个角色 / 换人设吗？**

可以。`roles/` 下放多个 `.md`，在桥接配置里指定用哪个。每个角色一套语气，记忆是共用的（想隔离就换 `CHAT_KEY`）。

**能进群聊吗？**

能力有，但默认关闭。群里会有人乱逗她、费用也控不住，建议先私聊跑稳再说。

**能看懂图片 / 发语音吗？**

都不能。图片只能知道"有张图"，语音要先自备语音库。这是模型和协议端的限制，不是配置问题。

**会被封号吗？**

有概率。用的是非官方协议端，腾讯随时可能判违规。**用小号**，别拿主号试。安装脚本启动前也会提醒这一点。

**数据存在哪？怎么备份？**

全在安装目录下：

| 内容 | 位置 |
|---|---|
| 长期事实 + 随身本 | `<桥接>/state/social-v2.json` |
| 每日摘要 | `archive/summary/*.md` |
| 完整聊天 | `archive/logs/*.md` |
| 换会话快照 | `chat-memory/*.json` |

`maintenance` 每天 04:00 会打一份加密 7z 到 `backups/`（要装 7-Zip）。

**换台电脑怎么迁移？**

把整个安装目录拷过去，在新机器上跑一次 `install.cmd`（它会重新注册计划任务和电源设置），再双击三个启动器。

**支持 Linux / macOS 吗？**

不支持。脚本用了 PowerShell、`netstat`、Windows 计划任务。移植要重写这一层。

## 一天花多少钱

按实测数据算（DeepSeek 官方价：缓存命中 0.2 / 未命中 2 / 输出 8 元每百万 token）：

```
平均上下文 40,000 token
每句话 ≈ 1.2 分钱
一天聊 150~300 句 ≈ 2~4 元
```

**其中 68% 花在"缓存命中的上下文"上**——也就是"她记得多少"，而不是"她说了多少"。所以省钱的关键是压上下文，不是让她少说话。

| 想省到什么程度 | 怎么做 | 代价 |
|---|---|---|
| 一天 ~2 元 | 默认配置 | 无 |
| 一天 ~1.5 元 | `ROTATE_AT` 降到 20000 | 换会话更频繁，当场记得的细节变少 |
| 一天 ~1 元 | 关掉主动开口 + 上下文再压 | 她基本只在被叫时说话 |

长期事实（作息、口味、忌口）**不受影响**——那一层只增不删。

## 和其他方案比

| | LangBot / AstrBot | 本项目 |
|---|---|---|
| 定位 | 接入框架，平台多 | 接入之后的运维层，只管 QQ |
| 记忆 | 会话级 | 四层（长期事实 / 随身本 / 摘要 / 全文档案） |
| 上下文 | 聊到满为止 | 超阈值换会话，交接记忆和最近对话 |
| 成本控制 | 无 | 余额四档提醒 + 余额越低说话越少 |
| 出故障 | 看日志 | 全栈体检每 2 分钟自愈 + 每日自检 |
| 上手 | Docker 一把梭 | 要装四样东西，但装完不用管 |

它不解决"怎么接上 QQ"——那件事别人做得更好。它解决"接上之后怎么不崩、不忘事、不偷偷烧钱"。
## 维护这套东西时容易犯的错

这类项目有个特殊之处：**同一份脚本存在两个地方**——你本机跑着的那一份，和 GitHub 上脱敏后的那一份。改了一边忘了另一边，就会出问题。

### ① 改了一边忘了另一边

真事：`context-guard` 的修复只写进了仓库，本机跑的还是老代码，两边差了两天没人发现。

自带的检查工具：

```powershell
node tools/sync-check.mjs --live E:\qq-bot-stack --repo E:\qq-bot-stack-os --names "你的角色名,昵称"
```

它会把本机的真实值（安装路径、QQ 号、角色名）替换成仓库里的占位符，再逐字节比对：

```
内容不一致（需要双向同步）（2）
  context-guard\context-guard.mjs
  self-check\self-check.mjs
只在仓库里有（本机缺）（7）
  install.ps1  ...
只在本机有（仓库缺）（30）
  3-keep-awake-settings.ps1  ...
```

**看到不一致先想清楚哪边新**，再同步，别盲目覆盖。

### ② 脱敏会把代码改坏

把 角色名 替换成 `<BOT_NAME>` 的时候，**代码里的文件名也会被替换**：

```js
const roleFile = path.join(BRIDGE, 'roles', '<BOT_NAME>.md');   // ← 文件根本不存在
```

所以：

- 脱敏后**必须跑一遍测试**（`regression.mjs`、`self-check.mjs`），脱敏改坏的东西只有测试能抓到
- 测试里不要写死人设文件名，改成自动发现（`roles/` 下第一个非 README 的 `.md`）
- 提示语里的路径别用 `<STACK_ROOT>` 这种占位符，改成「安装目录里的 xxx」，否则用户看到会懵

### ③ `.gitignore` 整目录排除会吞掉必需文件

```
archive/          ← 这样排除，里面的文件**无法**再开例外
```

`archive/collector.mjs` 就这么被吞了，仓库里一直缺档案收集器，新用户 clone 下来档案功能整个没有，而且**不报任何错**。

要用目录内容匹配才能开例外：

```
archive/*
!archive/collector.mjs
```

同一个坑在 `versions/` 上也犯了一次。

**自查方法**：把 `cron` 和 `supervisor` 里引用的每个路径逐个 `Test-Path` 一遍。

### ④ 只改一处 copy，忘了另一处 copy

`2-启动桥接.bat`、`stack-doctor.cmd` 这类启动器，本机有一份、`install.ps1` 里还生成一份模板。改了一个另一个不改，新装的人拿到的是旧行为。

改启动器时，两处一起看。
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
├── donate/           打赏（放收款码的地方）
├── eye-drop/         按醒来时间排提醒
├── like-card/        名片点赞（0 token）
├── lock/             心跳单例锁
├── maintenance/      日志轮转 + 备份
├── memory-summary/   每日摘要
├── memory-tidy/      记忆整理
├── napcat-watchdog/  掉线弹窗（stack-doctor 调它）
├── notify/           告警出口
├── patches/          补丁自检
├── patrol/           每日巡检（09:00 / 21:00）
├── power-guard/      断电保护
├── regression/       回归测试
├── roles/            人设（自己写）
├── self-check/       自查
├── session-janitor/  会话清理
├── stack-doctor/     全栈体检（每 2 分钟）
├── stack-guard/      整链守护
├── supervisor/       进程总管
├── tools/            零散工具（关网卡省电等）
└── versions/         版本快照（23:40 自动打）

根目录还有：
  config.example.json            桥接配置模板（复制成 config.json）
  silence-schedule.example.json  静默时段模板（复制到桥接 state/ 下）
  install.cmd / install.ps1      一键部署
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

**PolyForm Noncommercial 1.0.0** —— 只授权非商业用途。

- 可以：自己用、改代码、分享给朋友、放进个人项目、学习和研究
- 不可以：拿去卖、打包成付费服务/教程、放进商业产品
- 商用授权需要单独联系作者

全文见 [LICENSE](LICENSE)。
