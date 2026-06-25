# Agent Reachability — 让 agent 可达性成为一等公民

- **日期**: 2026-06-25
- **分支 / worktree**: `feature/reachability` (`../open-tag-reachability`)
- **base**: `de8621a` (含 #51 authz IDOR 修复)
- **状态**: 设计已批准，进入实现

---

## 1. 问题

当 daemon 不在线 / agent 所在机器离线时，用户**无感知**：

- 在 channel 里 @agent 或发消息 → 消息正常落库、UI 正常显示 → 但 agent 永远不回，**零提示**。
- 你（开发者）只有打开浏览器 console 看到 `{"error":"no daemon online"}` 才发现。

## 2. 现状全景（带证据）

### 2.1 后端对"在线状态"是健全的

机器在线/离线有完备的实时信号通道（前端 100% 收得到）：

- daemon 连接 → `publish({type:"machine", online:true, ...})` (`ws.ts:onReady`)
- daemon 优雅断开 → `publish({type:"machine", online:false, ...})` (`ws.ts` close handler)
- 心跳恢复 → 同上 online (`ws.ts` pong handler)
- 断电/断网这种**非优雅断开** → `machineLiveness.ts` sweeper 90s(`STALE_MS`) 内兜底 offline，并把该机器上 active 的 agent 一并 publish offline
- server 重启 → `reconcileMachinesOnBoot()` 全部 offline，daemon 重连再 online

### 2.2 `no daemon online` 不是一个错误，是三条严重程度不同的路径

| 用户操作 | 代码 | 离线时行为 | 用户感知 |
|---|---|---|---|
| **发消息 / @agent / DM**（最高频）| `core.ts` `createMessage` ~341-353 `broadcastToDaemons` | **fire-and-forget，不检查 daemon 在线**，消息照常落库、返回 200 | **零感知**，连错误都不产生 |
| 手动 start/restart agent | `routes-api.ts` agent lifecycle | 返回 **503 + reason** | 前端 `ctl()` 不看返回值 → 静默 |
| 创建 agent | `routes-api.ts` `POST /api/agents` → `startAgent` | `startAgent` 返回 `ok:false`，**不阻塞创建**，响应带 `started:false` | 前端不读 `started` → 静默 |
| 读 workspace 文件树/skills | `routes-api.ts` `requestDaemon` | `{error:"no daemon online"}` (HTTP 200 body) | Workspace tab 展示（唯一展示处）|

### 2.3 前端呈现严重不足

- 无全局 toast/notification 系统；错误靠散落的 `alert()`(2 处) / `form-err` / `empty` 文字。
- ✅ Computers 页：状态点 + online/offline + Reconnect 按钮（#50，gated by `manageMachines`）。
- ⚠️ DM composer：`Chat.tsx:308-318` 有 offline banner，**但文案撒谎**（见 2.4）。
- ❌ Channel @agent：完全无离线提示。
- ❌ Start/Restart：503 被 `Members.tsx:160 ctl()` 静默吞掉。
- ❌ 创建 agent：`started:false` 被 `Members.tsx:444` 忽略。

### 2.4 一个更深的洞：离线消息"无限期滞留"，DM 文案是虚假承诺

DM banner 文案 *"Messages will be queued and delivered when it reconnects"* 与实现不符：

- 消息确实持久化在 DB（`channel_members.last_read_seq` 不动 → 它是未读）✓
- 但**"重连即送达"不成立** ✗：`ws.ts onReady` 重连时只做 stale-agent 对账（把 DB active 但实际没跑的标 inactive），**不重启 agent、不补投消息**；agent 又是 deliver 驱动、不轮询（`prompt.ts:89`）。那条 @消息会一直躺在未读里，直到下次偶然有人再唤醒该 agent，它启动时 `STARTUP_NUDGE`/`RESUME_NUDGE` 自驱 `message check` 才被看到。

对比鲜明：人类侧 socket 重连会 `/api/messages/sync?since=lastSeq` 增量补拉错过的消息(`store.tsx:216-225`)；**agent（机器）侧重连却没有对称的 catch-up**。

## 3. 第一性原理

open-tag 的心智模型是 **"agent 是像人一样的队友，你 @它、给它发消息"**。这成立的隐性前提是：agent 背后的机器在线、daemon 在跑、进程活着——但这个前提对用户是**不可见的基础设施**。

> **根因：agent 的「可达性 reachability」没有作为一等公民呈现在用户交互的当下，也没有在机器恢复后被自动闭合。**

解法不是"哪报错弹哪 toast"（打补丁），而是两件对称的事：
1. **呈现**：用户即将/正在跟不可达 agent 交互时，主动、就地、诚实告知。
2. **恢复**：机器重连时，自动把离线期间该处理而没处理的消息闭合（= agent 侧的 reconnect catch-up）。

## 4. 设计总览（两个正交 plane）

- **Plane A（后端）**：机器重连 → 按需唤醒"有待处理未读"的 agent，让它自己 `message check` 补处理。
- **Plane B（前端）**：可达性就地呈现 + 轻量全局 toast。

两者独立可测、独立有价值。

---

## 5. Plane A — 后端 reconnect catch-up

### 5.1 核心机制（优雅之处）

"补投离线消息" ≠ 造消息重放。agent 启动的 `STARTUP_NUDGE`/`RESUME_NUDGE`(`prompt.ts:127-131`) 本就驱动它 `message check` 把所有未读（`seq > lastReadSeq AND senderId != self`）拉出来处理。**所以补投 = 按需把该 agent 唤醒一次，它自己拉。**

### 5.2 触发点

`ws.ts onReady`，在现有 stale-agent reconciliation **之后**追加一次 catch-up。逻辑独立成新模块 `src/server/reconnectCatchup.ts`，保持 `ws.ts` 聚焦于连接管理。

### 5.3 算法

```
catchUpAgentsOnMachine(serverId, machineId, runningIds):
  agents = DB.agents where machineId = machineId AND deletedAt is null
  for a in agents:
    if not hasWakeableBacklog(a): continue          # 关键：不无脑唤醒，省 token
    if a.id ∉ runningIds:                            # 硬离线：进程死了
        broadcastToDaemons(serverId, {type:"agent:start", agentId:a.id, config: await agentConfig(a.id)})
        # agent 启动后 RESUME/STARTUP nudge 自驱 message check，拉全部未读（含错过的）
    else:                                            # 软离线：WS 断但进程还活着
        broadcastToDaemons(serverId, {type:"agent:deliver", agentId:a.id, ...notice})
        # agent:start 对活着的进程是 no-op（agentManager.ts:80），必须用 deliver 注入 inbox notice 驱动它 check
```

- `agentConfig(agentId)` 已在 `core.ts:247` 导出，直接复用。
- `runningIds` = `onReady` 收到的 `msg.runningAgents`，天然区分软/硬离线。

### 5.4 未读口径 —— 保守口径 Y（与在线 `createMessage` 唤醒口径严格一致）

`hasWakeableBacklog(agent)` 判定（精确复现"假如当时在线会不会唤醒它"）：

- agent 的某个 **DM channel** 有 `seq > lastReadSeq AND senderId != agent` 的消息 → 是
- agent 的某个**普通 channel** 有未读，且该未读消息 **@了此 agent**（join `message_mentions` 表，`schema.ts:142`）→ 是
- agent 的某个**普通 channel** 有未读，且 agent 持有 `inbox:receive` scope（ambient 唤醒）→ 是
- 否则 → 否

> **为什么不用"任何未读就唤醒"的宽松口径**：那会让离线补偿比在线更激进——在线时 ambient 无 scope 不唤醒、离线重连却唤醒，行为不一致，还凭空多一条烧 token 路径（已知 open-tag "唤醒零闸门 / ambient 刷屏"老毛病）。闭环只复现，不放大。

判定口径必须与 `core.ts createMessage` 的唤醒分支（DM/@ 无条件、ambient 需 `inbox:receive`）保持同源；实现时把这条规则抽成一处共享判定，避免两套口径漂移。

### 5.5 幂等 / 抖动防护

- **`lastReadSeq` 是天然幂等闸**：agent 一旦 check，未读清零，下次 onReady 它没 backlog → 不重复唤醒。
- `agent:start` 幂等（`agentManager.ts:80` `if (has) return`）；`agent:deliver` 有 3s debounce（`agentManager.ts:151`）。
- 兜底：同一 machineId 在 N 秒（如 30s）内不重复跑 catch-up，防连断风暴。内存级 Map<machineId, lastRunTs> 即可（单实例假设，与 `daemonHub` 一致）。

### 5.6 副作用红利

DM banner 那句"重连后送达"**从此成真**：离线时发的消息落库变未读，机器重连 → catch-up 唤醒 agent → agent check 到并处理。

### 5.7 涉及文件

- 新建 `src/server/reconnectCatchup.ts`（catch-up 主逻辑 + `hasWakeableBacklog`）。
- 改 `src/server/ws.ts`（`onReady` 末尾调用 catch-up）。
- 可能微调 `src/server/core.ts`（若把 createMessage 的唤醒口径抽成共享判定函数）。

---

## 6. Plane B — 前端可达性呈现 + 轻量 toast

### 6.1 轻量全局 toast（新基础设施）

- 新建 `web/src/toast.tsx`：`ToastProvider` + `useToast()`，**仿照现有 `ConfirmProvider`(`ConfirmModal.tsx`) 的 context 模式**，保持一致；无第三方库。
- API：`const toast = useToast(); toast.error(msg) / toast.info(msg)`。
- 渲染：固定定位容器，自动消失（~4s）+ 可手动关。样式加到 `styles.css`，复用现有 CSS 变量（`--success/--amber/--danger/--muted`）。
- 挂载：`main.tsx` 挂在 `<StoreProvider>` 内、`<ConfirmProvider>` 同层（main.tsx:40-41）。

### 6.2 操作失败接入 toast（只在关键点显式，不在 `api()` 层全局兜底）

| 改动 | 文件 | 内容 |
|---|---|---|
| Start/Restart 失败 | `Members.tsx:160 ctl()` 及 164-166 | 检查返回值；`r?.error`/503 → `toast.error`（如"机器离线，无法启动；请先重连机器"）|
| 创建 agent 未启动 | `Members.tsx:444` | 读 `r.started === false` → `toast.info`（"已创建，但所在机器离线未启动；机器上线后会自动恢复"）|

> 不在 `api()`(`store.tsx:81-87`) 层全局自动弹：很多调用方靠 body 的 `error` 字段自处理，全局兜底会重复/误报。精准优于宽泛。

### 6.3 channel @agent 离线 banner

- 扩展 `Chat.tsx:308-318` 现有 `topSlot` wake-hint：从"只 `isDm && dmAgent`"扩展到 channel。
- channel 模式：聚合当前频道里 **agent 成员**的可达性（其 `machineId` 对应机器 `status !== "online"`，或无 `machineId`）。判定数据全在 `store` 的 `machines` + `agents` + 频道成员里，**不发额外请求**。
- 文案：如"本频道有 N 个 agent 当前不可达（机器离线），消息会在机器上线后自动送达"。
- **实现时待定**：Chat.tsx 在 channel 模式下当前频道 agent 成员列表的数据来源——确认 Chat 是否已有 members 数据，没有则用 `store.agents` ∩ 频道成员（必要时复用 `/api/channels/:id/members`，注意 #51 已给它加 serverId scope + 404）。这是 Plane B 最不确定的一块。

### 6.4 DM banner 文案校准

- `Chat.tsx:310-314` 的文案 + 代码注释(309)里"queued"措辞 + i18n `chat.machineOffline`(en/zh) 一并校准为与闭环一致的准确表述（"机器离线，重连后自动恢复处理"）。

---

## 7. 数据流

```
离线期间:
  用户 @agent → createMessage 落库 (seq 自增, lastReadSeq 不动 → 未读)
             → broadcastToDaemons fire-and-forget (无 daemon, 丢弃)
  前端: 该频道/ DM composer 顶部 banner 提示 agent 不可达

机器重连:
  daemon → ws onReady (ready, runningAgents)
        → ① stale-agent reconcile (现状)
        → ② catchUpAgentsOnMachine (新增)
             → hasWakeableBacklog? → agent:start(硬离线) / agent:deliver(软离线)
        → agent 启动/被通知 → message check → 拉未读 → 处理 → message send → 回复用户
```

## 8. 错误处理

- catch-up 内任一 DB/广播失败：`try/catch` 包住，记日志，不阻断 `onReady`（`onReady` 的健康度优先于 catch-up；catch-up 是 best-effort 补偿）。
- catch-up 不改变任何现有返回语义；纯增量。
- 前端 toast 失败无副作用。

## 9. 实现顺序

1. **Plane A 后端闭环**（核心价值，可独立单测 + e2e）
   - `reconnectCatchup.ts` + `hasWakeableBacklog`（口径判定可单测）→ 单测
   - 接入 `ws.ts onReady`
   - typecheck（root）
2. **Plane B 前端**
   - `toast.tsx`（仿 ConfirmProvider）+ styles + main.tsx 挂载
   - Start/Restart/创建 反馈接 toast
   - channel banner + DM 文案校准 + i18n
   - typecheck（web）
3. **端到端验证**（见 §10）— `dev:e2e` 真 stack + 浏览器
4. **doc-sync**（见 §11）
5. PR

## 10. 验证矩阵（`dev:e2e` 真 stack，真 claude agent + 浏览器）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 硬离线(杀 daemon) → channel @agent → 重启 daemon | 重连后 agent 自动醒、check 到消息并回复 |
| 2 | 软离线(WS 断进程活) → @agent → WS 重连 | 重连后 agent 收 inbox notice、check 并回复 |
| 3 | 离线时打开 channel composer | 显示离线 banner |
| 4 | 离线时打开 DM | 显示校准后文案 |
| 5 | 离线时点 Start | toast 报错 |
| 6 | 离线时创建 agent | toast 提示未启动 + 会恢复 |
| 7 | 机器有 2 agent，只 @ 其一，重连 | **只**被 @ 的醒，另一个保持 inactive（不烧 token）|
| 8 | ambient 无 scope，发非 @ 消息，重连 | agent **不**醒（与在线口径一致）|
| 9 | 机器快速连断连 | 无重复唤醒/重启风暴 |
| 10 | 有未读时重启 server | daemon 重连触发 catch-up，处理未读 |
| 11 | 回归：在线正常 @agent | 即时响应，无 banner、无 toast |

每条要贴真实证据（日志 / 截图 / 命令输出）。Fail loud：明确列出跳过了什么、有何 warning、哪些路径没验到。

## 11. YAGNI / 不做

- 多实例水平扩展的 catch-up（沿用单实例假设，`realtime.ts` 已标 TODO redis-adapter）。
- 不重写 inbox notice 格式（`mentioned` 字段渲染）。
- 不改 `lastReadSeq` 语义。
- 不引入 agent 轮询（保持事件驱动）。
- 不引第三方 toast 库。

## 12. doc-sync 影响（实现同一 commit/PR 内更新）

- `ARCHITECTURE.md`：新增 `reconnectCatchup.ts` 模块 + `onReady` 行为变化（codemap / contracts）；web 新增 `toast.tsx`。
- `FEATURES.md`：勾选"机器重连自动恢复 agent + 离线消息补投"+"离线可达性提示"。
- `docs/tech-debt-tracker.md`：DM 文案 over-promise 这条债标记已修复（若已登记）/ 或记录新现状。
- `README.md`：如适用，"Verified" 区补一条。
