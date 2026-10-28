# QQ Bot Stack

> 分享给那些愿意和我一样折腾的人。

## ⚠️ 最上面先说清楚（这 8 条不接受就别往下装）

1. **不是装完就能聊的机器人。** AI 那层是 [DeepSeek Harness](https://github.com/deepseek-ai)，QQ 那层是 [NapCat](https://github.com/NapNeko/NapCatQQ)，中间还有桥接——这个仓库只补"接上之后"那一层，那三样得你自己装（[下载清单](#需要什么)）。**也不含人设**，她什么性格得你自己写（[`roles/README.md`](roles/README.md) 有模板）。
2. **只有 Windows。** Linux / macOS 都不支持，NapCat 和计划任务都是 Windows 那一套。
3. **用小号，别用大号。** 非官方协议端，有封号风险；封了没人赔。
4. **电脑要一直开着。** 关机、睡眠、合盖 = 她下线。笔记本记得插电，`install` 会顺手关掉自动睡眠和快速启动。
5. **要花钱，花的是你自己的 API key。** 一天 2~4 元；余额见底前会提醒你，不充就停。
6. **聊天内容会离开这台电脑。** 得发给 DeepSeek 才能生成回复，同时在本地留一份全文档案（`archive/`）。介意就别用。
7. **免费，但非商用。** 有人在任何平台卖它，就是骗子——正版只有这个仓库。授权是 PolyForm Noncommercial 1.0.0：自己用、改、送人都行，卖钱不行。
8. **没有客服。** 自己折腾的东西，仓库给了自检、体检、踩坑记录，但没有谁替你兜底。

八条都能接受，再往下看细节。

## 一分钟看完

**这是什么**：一套让 QQ 机器人**扛得住长期运行**的运维代码——记忆、换会话不忘事、进程互相看着、每天自查、余额快没了提前喊你。

**它能给你**：记住事、不越聊越贵、进程挂了能自己爬起来、出事有人报。做不到的、会出的问题写在「能做到什么 · 做不到什么」里，别期待错。

**大概要花多少**：一天 2~4 元（API 费用）、380 MB 磁盘、0.4% 的 CPU，详见[部署后占多少资源](#部署后占多少资源)。

**多久能跑起来**：装四样 + 扫码 + 写人设，顺利的话两小时以内。

## 先自测三条（30 秒，都答"能"再往下看）

| 问自己 | 为什么 |
|---|---|
| 有一台**常年开着**的 Windows 电脑吗？ | 它没法跑在云上：NapCat 得真登录 QQ，关机就断线；重连不顺利的时候要重新扫码 |
| 能接受**点几次 UAC 提权**、**扫一次码**吗？ | NapCat 要管理员权限才能挂到 QQ 上；第一次登录必须扫码（之后能用 `-q` 免扫） |
| 愿意花**两个小时**装四样东西、再写一段人设吗？ | 这仓库不含机器人本体，只做「接上之后」那一层——前面四样得你自己装 |

有一条答"不能"就先别急着装。装到一半卡住，比不装更难受。

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
| 聊久了上下文越滚越大，一天烧七块钱 | `context-guard`：上下文超线就换新会话，换之前把记忆和最近 20 句交接过去 |
| 换会话就失忆 | 四层记忆：长期事实 / 随身本 / 每日摘要 / 完整档案 |
| 进程不知道什么时候就死了 | `supervisor` 管 8 个后台脚本，`stack-doctor` 盯着 QQ / 桥接 / DSH / 脚本 |
| 改了代码要手动重启 | 心跳锁 + 热重载，改文件 3 秒生效 |
| 出问题没人知道 | `self-check` 每天自查，`stack-doctor` 每 2 分钟巡检 |
| 余额耗尽了才发现 | `balance-watch` 每 30 分钟查一次，分四档提醒 |

## 架构

```
QQ 客户端                                  ← 你手机/电脑上那个，用来跟机器人聊
   ↕
NapCat (:3000 HTTP / :3001 WS)             ← 替你登录 QQ（非官方协议端，要管理员权限）
   ↕
qq-bridge (:3100 控制台)                    ← 把 QQ 消息翻译给 AI，再把 AI 的话发回去
   ↕
DeepSeek Harness                           ← AI 在这里说话（也在这里烧 token）

旁边还有几个"看着它们的人"：
  supervisor     管 8 个后台脚本（记忆/余额/定时/巡检…），崩了 5 秒后重启
  stack-doctor   每 2 分钟体检一遍：QQ / 桥接 / DSH / 后台脚本，谁挂了拉谁
  stack-guard    更老的一层，10 秒看一眼 supervisor 和桥接（可选，一键部署不装）
```

一句话记住：**NapCat 管登录，桥接管翻译，DSH 管说话，supervisor 管别死。**

## 别人下载下来能直接用吗

**能，但要先把那四样装好**（下载地址见下面的 [需要什么](#需要什么)）——这个仓库只做「接上之后」的那一层，机器人本体不在这儿。

装好人设之后跑 `install.cmd`，体检会告诉你还缺哪个。

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

## 需要什么

### 硬件：能跑的最低配置

| | 最低能跑 | 舒服用 |
|---|---|---|
| 系统 | Windows 10 64 位 | Windows 11 |
| CPU | 2 核 | 4 核以上 |
| 内存 | **8 GB**（4 GB 会卡，见下） | 16 GB |
| 磁盘 | 5 GB 空闲 | 20 GB |
| 网络 | 能稳定连外网 | 有线 > Wi-Fi |

**为什么 4 GB 不行**：Windows 自己吃 3 GB 左右，DeepSeek Harness 桌面版再吃 500 MB，NapCat 和 QQ 又要 200 MB —— 4 GB 的机器会一直换页，卡到没法用。**8 GB 是底线。**

**实际占用**（12 核 / 16 GB 机器实测）：整套 380 MB 磁盘、0.4% 的 CPU、700 MB 内存。详见 [部署后占多少资源](#部署后占多少资源)。

### 软件：下这五个，一个都别多下

| 装什么 | 下载地址 | **具体下哪个** | 干什么用 |
|---|---|---|---|
| **Node.js** | https://nodejs.org/zh-cn/download | 下拉到 **LTS** 那一栏 → **Windows 安装包 (.msi)** → 64-bit<br>⚠️ 别下 Current（尝鲜版），也别下 .msi 以外的 | 所有脚本的运行时 |
| **DeepSeek Harness** | https://www.deepseek.com/download/ | **Windows 版**（下完双击安装，装完先打开登录一次） | 真正说话的那层（AI） |
| **NapCat** | https://github.com/NapNeko/NapCatQQ/releases | 最新 release 里的 **`NapCat.Shell.Windows.Node.zip`**<br>⚠️ 不是 `Framework`、不是 `OneKey`，就认 `Shell.Node` 这个 | QQ 协议层 |
| **桥接** | https://github.com/h-D-ACE/dsh-qq | 右侧 **Releases** 里的最新版压缩包（本文档基于 `qq-bridge-enhanced v1.1.0`） | 把 QQ 消息接到 DSH |
| **7-Zip**（可选） | https://www.7-zip.org/download.html | **64-bit x64** 的 `.exe` | 加密备份用；不装只是备份不加密 |

另外还要两样「不是下载的」：

| 要准备的 | 在哪弄 |
|---|---|
| **DeepSeek API key** | https://platform.deepseek.com/api_keys → 创建，`sk-` 开头，复制保存（只显示一次） |
| **一个 QQ 小号** | 自己注册。⚠️ 别用大号，用非官方协议端有封号风险 |

**下载顺序建议**：Node → DSH → NapCat → 桥接。装完跑 `install.cmd`，它会告诉你还缺哪个。

## 部署后占多少资源

实测环境：**12 核 / 16 GB / Windows 11**，稳定运行 30 天的状态。

### CPU

```
整机平均         7.4%（12 核，约 0.9 个核）
  └ 其中我们的： 0.4%（QQ 1.9% + DSH 1.4% + DSH 1.1%，按单核算）
其余全是系统后台和 DSH 的界面渲染
```

**CPU 不是瓶颈。** 她那套脚本是「定时醒来干活」型，空闲时基本不占：

| 组件 | 频率 | 单次开销 |
|---|---|---|
| `stack-doctor` | 每 2 分钟 | 起一个 node 跑完就退，约 0.2 秒 |
| `archive` | 每 60 秒 | 读最近 80 条、追加一行 |
| `context-guard` / `balance-watch` / `budget-guard` | 几十分钟一次 | 一次 HTTP 调用 |
| `cron` | 每 30 秒 | 比一次时间戳 |

### 内存

```
整机已提交       8.6 GB / 16 GB
  └ 其中我们的： 708 MB（DSH 515 MB + QQ/NapCat 约 190 MB）
后台脚本全部    每个 20~40 MB，8 个合计约 250 MB
```

⚠️ **4 GB 内存的机器会比较紧**：Windows 自身 + DSH + NapCat 就要 6 GB 上下。建议 8 GB 起步。

### 磁盘

| 目录 | 占用 | 说明 |
|---|---|---|
| `napcat/` | **350 MB** | QQ 协议端本体，装完就不动了 |
| `dsh-qq/` | 28 MB | 桥接 + 依赖 |
| `archive/` | 0.4 MB | 聊天档案，一个月也就几 MB |
| `state/` `chat-memory/` `versions/` `reports/` | < 1 MB | 状态、快照、报表 |
| **整套合计** | **约 380 MB** | 不含 DSH 桌面程序本身 |

日志会自动轮转：单个 `.log` 超过 5 MB 改名成 `.1`，最多留 5 份；`token-usage.jsonl` 到 20 MB 才轮转。**不会无限膨胀。**

### 什么会随使用量增长

| 会涨 | 不会涨 |
|---|---|
| API 费用（每句话都要重算上下文） | CPU（空闲时几乎为 0） |
| 聊天档案和摘要（一天几十 KB） | 内存（进程数固定，不随消息量涨） |
| 备份目录（保留 7 天，自动清） | 磁盘占用（日志有上限） |

### 弱一点的机器怎么办

- **2 核 4 GB**：能跑，但 DSH + NapCat 同时在会明显卡；建议关掉 DSH 的界面（只留后台）
- **内存吃紧**：`budget-guard` 和 `session-janitor` 可以停掉，省 60 MB，功能影响很小
- **不想装 DSH 桌面版**：不行，AI 那一层就是它

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
2-启动桥接.bat          ← 起不来就等 stack-doctor 两分钟内拉一遍
20-supervisor.bat       ← 管后台脚本
```

## 脚本清单

| 脚本 | 频率 | 作用 |
|---|---|---|
| `supervisor` | 常驻 | 管 8 个 worker，崩溃 5 秒后重启（名单在 `supervisor/workers.mjs`，只有一份） |
| `stack-guard` | 常驻（可选） | 老的一层：10 秒看一眼 supervisor / 桥接。一键部署不装它，靠 stack-doctor 兜底 |
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

公共的东西全在 `lib/base.mjs`：部署路径、日志时间戳、桥接控制台调用、DeepSeek 计价。
脚本不再各抄一遍——以前 24 个文件抄同样的 4 行路径，改目录结构要改 24 处。

## 想改东西的时候，改哪儿

| 想改什么 | 去哪改 | 怎么生效 |
|---|---|---|
| 性格、说话方式、口癖 | `roles/<角色名>.md`（模板见 [`roles/README.md`](roles/README.md)） | 下一句对话就生效 |
| 什么时候别吵她（静默时段） | 桥接控制台 `:3100` 的静默配置，落在 `state/silence-schedule.json` | POST 一下即生效，不用重启 |
| 每天最多花多少钱 | 环境变量 `DAILY_BUDGET`（默认 5 元） | 下次检查（≤30 分钟） |
| 上下文多长才换会话 | `ROTATE_AT` / `URGENT_AT` / `CRITICAL_AT`（默认 24000 / 34000 / 46000） | 改完 3 秒自动重启 |
| 她多久主动说一次话 | 桥接 `config.json` → `socialV2.proactive`（`enabled` / `probability` / `idleThresholdMs`） | 重启桥接 |
| 每天几点跑哪些定时任务 | `cron/cron.mjs` 顶部那张表（03:30 补丁、04:00 备份、09:00 巡检…） | 改完 3 秒自动重启 |
| 滴眼药水提醒的节奏 | `EYE_DROP_OFFSETS`（默认 `2,7,12` 分钟）、`EYE_DROP_FROM_HOUR`~`EYE_DROP_TO_HOUR`（默认 4~12 点） | 改完 3 秒自动重启 |
| 余额提醒门槛 | `THRESHOLD_CNY`（最高档，默认 10 元），或 `balance-watch.json` | 下次检查（≤30 分钟） |
| 开放群聊 | 桥接 `config.json` → `allow.groups`（默认空 = 只接私聊） | 重启桥接 |
| 她能调用哪些工具 | 桥接 `config.json` → `socialV2.tools` | 重启桥接 |

表里的 `XXX` 都是环境变量：最省事的写法是在 `20-supervisor.bat` 里加一行 `set XXX=...`（它拉起的后台脚本都会继承），不想动启动器就用系统环境变量。改完把 supervisor 重启一次。

**桥接的 `config.json` 只在启动时读一次**，所以改完要重启桥接（控制台调 `/api/restart`，或重开 `2-启动桥接.bat`），不然改了没反应。

## 关键设计（为什么这么做）

### 记忆分四层，因为每层都会过期

```
长期事实   只增不删，上限 40 条     作息、口味、忌口、生日       ← 不会过期
随身本     话题 + 印象，14 天       正在聊的、对方的近况         ← 会过期
每日摘要   一天 3~4 条，永久保留     "昨天聊了什么"              ← 会过期
完整档案   每句话都存，永久         想翻旧账时全文搜索            ← 不会过期
```

话题会过期、摘要只留要点——**只有「长期事实」能保证"聊半年还记得你几点睡"**。所以那一层是只增不删的。

> ⚠️ 有个坑：`facts` 要同时出现在**五个地方**才不会丢——保存白名单、加载、清理、换会话恢复、断电恢复。少一处，平时没事，换会话那天全没了。本项目五处都处理了，你自己改的时候留意。

### 锁用「心跳」，不用进程号

```
每个脚本每 20 秒摸一下自己的 .lock 文件
新实例启动：锁 90 秒内被摸过 → 让位；否则接管
```

**为什么不用 pid**：Windows 会把 pid 复用给别的进程，锁就指向一个"活着"的陌生人，变成僵尸锁。
**为什么不用 `wmic` 查命令行**：Win11 已经删掉了 `wmic`。

### 改代码不用手动重启

脚本每 3 秒看一眼自己的文件有没有变（改了就退出），`supervisor` 5 秒后用新代码把它拉起来。**改完存盘，等 8 秒就生效。**

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

它专门盯**"坏了但看不出来"**的那几种：

| 查什么 | 坏了会怎样 |
|---|---|
| API key 一致性 | 环境变量里躺着一个失效的旧 key，余额告警/日报全静默 401 |
| 脚本重启循环 | 某个脚本每 5 秒崩一次，日志里只写"退出 code=0" |
| 记忆一致性 | 文件里有、提示词里没有，或反过来 |
| 档案完整性 | 文件在、行数在涨，但一句都没有对方说的 |
| 出戏检测 | 她说出"我是 AI"这类话 |

**建议加进 cron**（本项目默认每天 21:20 跑）。

## 全栈体检（stack-doctor）

每 2 分钟跑一次，跑完就退。检查四层，谁挂了拉谁：

| 检查项 | 判断方式 | 挂了怎么办 |
|---|---|---|
| QQ（NapCat） | `POST :3000/get_login_info` 有没有 `user_id` | `launcher.bat -q QQ号` 快速登录 |
| 桥接 | `:3100` 能不能连上 | 重新拉起启动脚本 |
| 桥接"假活" | NapCat 日志的"接收"时间 vs 桥接的 `lastIncomingAt` | 调 `/api/restart` 重启 |
| DSH 本体 | `tasklist` 里有没有 `DeepSeek Harness.exe` | 直接启动 exe |
| 后台脚本 | 8 个 worker 的锁有几个是新鲜的（5 分钟内），一半以上不新鲜就拉 supervisor | 重新拉起 supervisor |

**为什么是"跑完就退"，不是常驻进程**：

> 常驻进程有"活着"这个状态，所以它会死——而且死了没人知道。
> 实测过一次：看门狗 09:00 自己悄悄死了，13:33 QQ 掉线后**整整 7 小时**没人处理。
> 一次性脚本没有"活着"这个状态，也就死不了。

**为什么用 `explorer.exe` 启动桥接**：

> 计划任务必须提权（拉 NapCat 需要管理员），但桥接的 `state` 目录带一个"低完整性"标签，**高权限进程反而写不进去**——桥接会以 `EPERM` 创建锁文件失败、直接退出，表现为"守护说已拉起，端口却永远是空的"。
> `explorer.exe` 是已登录用户的 shell，让它代开就退回普通权限，正好能写。

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
node tools/sync-check.mjs --live E:\qq-bot-stack --repo E:\qq-bot-stack-os
```

它会把本机的真实值（安装路径、QQ 号、角色名、昵称）替换成仓库里的占位符，再逐字节比对。
名字能从 `config.json` 和角色卡里自动认出来，认不出的再用 `--names "妹妹,大肥鱼"` 补。

```
内容不一致（需要双向同步）（1）
  context-guard\context-guard.mjs
```

**没有内容不一致就退出码 0**，可以直接接进脚本当闸门；「本机多出几个老文件」不算漂移，仓库本来就不收它们。

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

能收的都收成一份了：后台工人名单现在只在 `supervisor/workers.mjs`，supervisor 和 stack-doctor 都 import 它，加人只改一处。
（这条就是被 `eye-drop` 教会的：加完 supervisor 忘了改 doctor 那份，于是它死了也没人报。）

同一类重复在 2026-10-28 又清了一次：**24 个脚本各抄一遍的「路径 4 行」、日志时间戳、`console-token`、取主人 QQ、DeepSeek 计价**，全收进 `lib/base.mjs`。
当时抄得还不完全一样——时间戳有的带时区有的不带，日志里有两种日期格式。现在 `regression` 里有一条守着：谁再抄回去就报错。

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
├── lib/              公共件：路径 / 时间戳 / 控制台调用 / 计价，只有这一份
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
