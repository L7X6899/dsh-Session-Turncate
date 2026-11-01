# dsh-Session-Turncate

**中文简介**：针对单个会话的定时上下文截断插件。可配置「多少小时没有输入之后」，把更早的对话整段丢弃（不生成摘要），避免同一个长期会话（例如手机 IM 机器人桥接的会话）把上一个任务带进下一个任务。

**English**：Per-session idle-time context truncation for DSH Web. After a configurable number of idle hours the older conversation is dropped (no summary), so one long-lived session (e.g. an IM bridge) cannot leak one task into the next.

- 版本：**0.1.2**
- 包名：`dsh-session-turncate`　显示名：`dsh-Session-Turncate`
- 宿主：`dsh >= 0.2.1-rc.5`（`engines.dsh`）
- 许可：MIT

## 解决什么问题

一个 Session 可能长期存活（例如手机 IM 机器人一直往同一个会话投递消息），不同任务因此共用一份上下文，互相污染。

本插件给每个会话一个开关：开启后，只要**距上一次活动已满 X 小时**，下一次开始处理消息时就把**更早的整段对话丢弃**（不调用模型生成摘要），只留一条分界说明。

> 这是「截断」，不是「压缩」。被丢弃的内容不会留下摘要，也不会再出现在模型输入里。

## 界面：会话上方「上下文截断」选项卡

会话区域顶部的功能栏（对话 / 轨迹 / 上下文 / …）新增一项 **上下文截断**（slot `conversation.view`，order 40）。面板内容：

| 区域 | 行为 |
| --- | --- |
| 上下文管理 | 开关。启用后当前会话长时间无输入时会话将自动重置，有效降低 token 消耗。 |
| 自动截断上下文时间 | 数字输入框，单位小时，范围 **0–24**。输入框带 ▲ / ▼ 按钮（浏览器原生 spinner 也在），方便增减。填 `0` 表示不按时间自动截断。 |
| 保存 | 写入该会话的开关与小时数。 |
| 立即截断 | 立刻执行一次截断（不受时间限制）。 |
| 状态行 | 上次截断时间与累计次数。 |

面板通过同源 HTTP 接口与宿主通信：`POST /session-turncate/api`，`op` 为 `status` / `set` / `cut`。接口只接受 loopback 或同源请求，跨源返回 403。

## 命令

```
/truncate on 4     # 开启，并在 4 小时无输入后截断
/truncate on       # 只开启，沿用已保存的小时数
/truncate off      # 关闭
/truncate now      # 立即截断一次
/truncate status   # 查看当前会话的状态
```

中文别名同样可用：`/截断 on 6`、`/cut off`。

通过 IM 桥接直接发消息（不经过命令注册表）时，这一行**必须**以 `/`、`／` 或 `!` 开头，否则会被当成普通对话：`!截断 on 2` 会生效，`截断 on 2` 不会。

每次开关/截断都会得到一条「回执」消息，让手机端也能看到结果。

## 触发时机

自动截断在每一步（step）开始时判断，并且只在本轮的第一个 step 执行：

1. 本轮已经产生的 surface 节点不会被替换；
2. 有未闭合的 `compaction/start` 时直接跳过；
3. 空闲计时按「上次活动时间」计算，`hours <= 0` 或开关关闭时不触发。

## 存储

`$DSH_HOME/session-truncate.json`（默认 `~/.dsh/session-truncate.json`），按 Session id 记录。进程重启后仍然有效。

```json
{
  "version": 1,
  "sessions": {
    "<sessionId>": {
      "enabled": true,
      "hours": 4,
      "keepRecentNodes": 0,
      "lastActiveMs": 1762000000000,
      "lastCutMs": 1762014400000,
      "cutCount": 3
    }
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `enabled` | 会话开关 |
| `hours` | 空闲多少小时后截断（0 = 不按时间自动截断，24 为上限） |
| `keepRecentNodes` | 保留末尾多少个 surface 节点不参与截断（默认 0） |
| `lastActiveMs` | 上次活动时间，空闲计时起点（旧字段 `anchorMs` 会自动迁移） |
| `lastCutMs` | 上次截断时间 |
| `cutCount` | 累计截断次数 |

手动编辑该文件同样生效（插件每次读盘；解析失败会把坏文件另存为 `.corrupt` 后重置）。

## 截断是怎么写进会话的

严格照抄内置压缩后端的事务形状，因此 Chat 里会显示一张「已压缩」折叠卡，历史不会凭空消失：

1. `compaction/start`；
2. `compaction/summary`（固定文案，声明这是按时间策略移除、未生成摘要；`provider` 为 `session-turncate`）；
3. 一条 `user/message`（`source.kind` 为 `compact-checkpoint`），带 `surfaceOp: { op: 'replace', startSeq, endSeq }`，`sourceEventSeqs` 覆盖被替换区间内的每个 surface 节点；
4. `compaction/end`。

`compaction/start|end` 的 `turn` 字段必须存在（无 turn 时写 `null`），否则会话下次加载会因格式校验失败而报错。

## 安装

**从 GitHub（推荐）**

```sh
# 把 desktop 换成你实际使用的 profile 名
dsh plugin --profile desktop add github:L7X6899/dsh-Session-Turncate
```

桌面端也可以走应用内的 **设置 → 插件** 安装。装完**重启 DSH**（宿主按 ESM 模块缓存加载插件）。

**从 npm（暂未发布）**

`dsh-session-turncate` 还没有发布到 npm registry，在你看到它出现在 npmjs.com 之前，下面这条命令会失败；请用上面的 GitHub 方式。

```sh
npm i dsh-session-turncate
```

**本机开发目录**

把目录以 link 方式装进 profile 的 `dsh.profile.bundles`，由 DSH 的插件管理器完成，不需要手写 `cordis.patch.yml`。

## 自测

仓库自带五个纯 Node 测试脚本，直接模拟 session 与宿主 ctx，不需要启动 DSH：

```sh
node test/truncate.mjs   # 32 项：区间选择与 surface 替换
node test/receipt.mjs    # 11 项：回执注入与状态落盘
node test/fixes.mjs      # 20 项：边界与回归
node test/api.mjs        # 41 项：面板接口、空闲策略、来源校验、排队截断
node test/fix012.mjs     # 16 项：0.1.2 回归（Invalid Date、lastActiveMs、排队执行）
```

## 失败时的行为

任何异常都只记一条 warn 日志，然后原样继续本轮对话；插件出错不会中断会话。状态文件写入失败时，面板与命令都会明确返回「本次操作未生效」。

## 更新日志

### 0.1.2

- 修复 `/truncate status` 与面板显示 `Invalid Date`：计时字段改名后仍有代码读取旧的 `anchorMs`，现在统一按 `lastActiveMs` 计算「下次截断」。
- 修复面板「立即截断」报「该会话当前未加载」：宿主补齐 `sessions` / `agents` 服务注入，并在确实无法解析内存会话时把请求排队，下一次输入时执行截断。
- 面板状态行新增「下次」时间与排队提示；时间格式统一为 `YYYY-MM-DD HH:mm`。
- 统一日志前缀为 `session-turncate:`。

### 0.1.1

- 新增会话上方的「上下文截断」选项卡（空闲总开关 + 0–24 小时数字输入）。
- 计时语义从「固定间隔」改为「空闲超时」：每次输入都会刷新计时。

### 0.1.0

- 首个版本：按会话的定时上下文截断，四事件 compaction 事务，`/truncate on|off|now|status` 命令。

## License

MIT © L7x