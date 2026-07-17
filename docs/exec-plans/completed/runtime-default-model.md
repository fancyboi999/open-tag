# runtime-default-model — claudecode / codex 支持"使用本地默认"

> ✅ **Shipped** — PR #151（commit `c290ba0`）+ daemon 0.7.1（2026-07-02 发布）。`buildClaudeArgs` 纯函数 + `--effort` 透传 + UI「使用本地默认（推荐）」均已落地；FEATURES.md P6 已勾选。2026-07-06 移入 completed/。

## 背景

创建 claude / codex agent 时无法选"使用本地默认（不指定模型/思考强度）"。链路有三层阻挡：

1. **UI**（`web/src/views/Members.tsx` CreateAgentModal）：probe 出模型列表后默认选第一个具体模型，没有"本地默认"项。
2. **后端兜底**（`src/server/routes-api/agents.ts:35`）：`model: b.model || "sonnet"` 把 null 强改成 "sonnet"（对所有 runtime 生效）。
3. **claude runtime**（`src/daemon/claudeRuntime.ts:29`）：`"--model", opts.model ?? "sonnet"` 永远硬塞 `--model`。

另外 **PR #65 的 half-finished 残留**：#65 给 UI 加了 claude 的 effort levels 探测和选择器（codex 那边接通了 `codexRuntime.ts:13-23`），但 **claudeRuntime 从未透传 `--effort`**（`git log -S "effort" -- claudeRuntime.ts` 为空）——UI 选了思考强度不生效。当前 claude CLI v2.1.197 的 `--help` 明确支持 `--effort <level>`。

## 目标契约

- **终态**：创建 claude/codex agent 时，模型选择器顶部有"使用本地默认（推荐）"且默认选中；选中 → 后端 `model=null`、不传 `--model`/`--effort` → CLI 完全用本地配置。选具体模型/级别 → 按原逻辑透传。原选项全部保留。
- **证据**：
  1. 单测：`buildClaudeArgs` 在 (model=空, effort=空) 时 args 不含 `--model`/`--effort`；(model, effort) 时含。
  2. dev:e2e 创建选"本地默认"的 claude agent → `psql` 查 `model IS NULL` + `cli.log` 无 `--model` + 发消息能跑通一个 turn。
  3. chrome-devtools 截图 UI 的"本地默认"选项。
- **约束**：不动鉴权；不动 schema（model 列本就 nullable）；不破坏存量 agent（model 非 null 照旧）；其他 runtime UI 本次不加选项（后端顺带放开 null，已逐 runtime 验证安全：cursor/kimi/pi/copilot buildArgs 均 `model && model!=="default" ? model : ""`；opencode 同；codex `opts.model || null`）。
- **ceiling**：3 轮实现尝试，超过停下找用户。

## 改动点

| 文件 | 改动 |
|---|---|
| `src/daemon/claudeRuntime.ts` | 抽 `buildClaudeArgs` 纯函数；`--model` 条件展开（`opts.model ? [...] : []`）；**补 `--effort` 透传**（读 `runtimeConfig.reasoningEffort`，allow-list 防注入） |
| `src/server/routes-api/agents.ts:35` | `b.model \|\| "sonnet"` → `b.model \|\| null` |
| `web/src/views/Members.tsx` (CreateAgentModal) | claude/codex 模型列表前插虚拟项 `{id:"__default__",label:"使用本地默认（推荐）"}`，默认选中；提交 `__default__`→`null` |
| `src/daemon/codexRuntime.ts` | 不改（model=null + effort 不传 已支持） |

## 测试

- **单测**（新建 `src/daemon/claudeRuntime.test.ts`，范式 `opencodeRuntime.test.ts`）：`buildClaudeArgs` 六种组合（空、model、effort、全有、effort 非法值、sessionId resume）。
- **E2E**：`npm run dev:e2e:up` → 浏览器创建 claude agent 选"本地默认" → psql + cli.log + 发消息三重验证 → chrome-devtools 截图。

## Daemon release（项目硬规矩）

改了 `src/daemon/claudeRuntime.ts` → bump `packages/daemon/package.json`（patch：bugfix 性质 #65 残留）+ 发 GitHub Release `vX.Y.Z`。

## doc-sync

- `src/daemon/listModels.ts` 顶部注释（claude 现在传 --effort）。
- `FEATURES.md` checkbox（如有相关条目）。
- daemon release notes。
