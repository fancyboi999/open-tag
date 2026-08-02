# reasonix-runtime — 新增 Reasonix runtime 适配器

> Reasonix(esengine/DeepSeek-Reasonix,v1.18.0)是 DeepSeek 原生的终端编码 Agent。open-tag
> 现有 runtime:claude / codex / copilot / opencode / kimi / pi / cursor / hermes。本计划按
> opencode/copilot 的 **one-shot-per-turn** 模式新增 reasonix 适配器。

## 背景

reasonix 无持久进程协议,但 headless 模式稳定:
- `reasonix run <task> --output-format stream-json` — 每行一个 eventwire JSON + 末尾 result 对象。
- 多轮续跑:`--resume <session 文件路径>`(注意:是**文件路径**,不是 session id;id 格式 `20260801-…-<model>` 即文件名)。
- session 存储:`~/.reasonix/projects/<encoded-cwd>/sessions/<session_id>.jsonl`(`encoded-cwd` = 绝对 cwd 把 `/` 和 `.` 换成 `-`)。
- 错误信号:执行失败 → result `is_error:true`(exit 0);启动/恢复失败 → 非零 exit + stderr。

**已实测抓取 fixture**(本机 reasonix v1.18.0,`--output-format stream-json`):
- `text` 增量、`message` 终稿、`tool_dispatch`(partial→完整带 args 两次,按 id 去重)、`tool_result`、`usage`、result(session_id)。
- 当前模型(hy3-ioa)不产出 `reasoning` 事件(`--show-thinking` 也不出)——映射仍防御性支持 `reasoning` 字段。
- 系统提示词:reasonix 无 per-run custom-instructions 标志,用 `runtimeInstructionEnvelope()`(写项目 `REASONIX.md` 会污染用户仓库)。

## 目标契约

- **终态**:reasonix 出现在机器 runtime 检测、创建 agent 的 runtime 选择、模型下拉(config 枚举);agent 能跑多轮 turn(每 turn 一个 `reasonix run` 进程,`--resume` 续链)。
- **证据**:
  1. 单测:纯函数 `handleReasonixEvent` 对真实 fixture 映射正确(partial/full tool 去重、result session_id 捕获、is_error 透出);`parseReasonixModels` 对真实 config 枚举模型。
  2. dev:e2e 用 `@dev-bot`(reasonix runtime)发消息跑通一轮 + 第二轮 resume 续链。
- **约束**:不改鉴权/schema;不动 prompt.ts;模型/effort 缺失时省略 flag(用 CLI 本地配置,同 claude/codex 模式);effort allow-list 防注入。
- **ceiling**:5 轮实现尝试,超过停下找用户。

## 改动点

| 文件 | 改动 |
|---|---|
| `src/daemon/reasonixRuntime.ts`(新) | one-shot-per-turn 适配器,镜像 opencode's OpencodeRun:spawn `reasonix run --output-format stream-json --permission-mode bypassPermissions [--model] [--effort] [--resume <sessionFile>] <envelope(msg)>`;逐行解析 eventwire→trajectory;捕获 result.session_id→推导 session 文件→下轮 `--resume`;is_error/non-zero exit→错误轨迹 |
| `src/daemon/runtimes.ts` | detectRuntimes 加 `reasonix`;REG 注册 reasonixRuntime |
| `src/daemon/listModels.ts` | `parseReasonixModels(toml)` 纯函数(解析 `[[providers]]` 的 `model`/`models`/`default` + 顶层 `default_model`);`discoverReasonixModels()` 读 `./reasonix.toml` + `~/.reasonix/config.toml`;listModels 加 case |
| `src/server/runtimeModels.ts` | DYNAMIC_RUNTIMES 加 reasonix |
| `src/server/routes-api/servers.ts` | MODELS 静态 fallback 加 `reasonix: [{id:"default",label:"Default (config.toml)"}]` |
| `web/src/views/misc.tsx` | RT_LABEL 加 `reasonix: "Reasonix"` |
| `src/daemon/__fixtures__/reasonix-*.jsonl`(新) | 真实抓取:文本流 / tool 流 / resume 续链 / is_error |
| `src/daemon/reasonixRuntime.test.ts`(新) | 纯函数映射测试,范式 `opencodeRuntime.test.ts` |
| `test/listModels.unit.test.ts` | 补 parseReasonixModels 用例 |

## 测试

- **单测**:`npx tsx --test src/daemon/reasonixRuntime.test.ts` + `npx tsx --test test/listModels.unit.test.ts`。
- **E2E**(涉及 agent runtime):worktree 内 `npm run dev:e2e:up` → 创建 reasonix @dev-bot → 发消息验证一轮 + 二轮 resume;`dev:e2e:down`。

## Daemon release(项目硬规矩)

改了 `src/daemon/**`(新 runtime)→ bump `packages/daemon/package.json`(minor:新 runtime)+ 同 PR 写
`packages/daemon/CHANGELOG.md` 条目 + 合并后发 GitHub Release `vX.Y.Z`。

## doc-sync

- `ARCHITECTURE.md` codemap(runtimes / listModels 相关条目 + reasonixRuntime 新条目)。
- `FEATURES.md`(reasonix runtime checkbox,若有条目)。
- `docs/PLANS.md`(active 索引)。
- 完成本计划后 `npm run /doc-sync` 审计。

## Progress log

- **2026-08-01** — 实现 + 单测完成(448/448 过,typecheck 过);doc-sync 完成(ARCHITECTURE / FEATURES / README / PLANS / CHANGELOG / schema 注释 / daemon version 0.15.0)。
- **2026-08-01 — live 验证(E2E 变体)** — docker 在本机未安装,`dev:e2e:up` 的完整 web 栈(PG:5433 / Redis)起不来;改用 runtime 层真机验证,同样覆盖 agent-runtime 路径:
  - `detectRuntimes()` → `reasonix detected: true` ✓
  - `listModels("reasonix")` → 枚举出真实 4 个模型(deepseek-v4-flash-ioa / deepseek-v4-pro-ioa / kimi-k3-ioa / hy3-ioa)✓
  - 真实 `reasonix run` 一轮 → `handleReasonixEvent` 捕获 session_id,结果 `is_error:false` ✓
  - **发现并修复 bug**:reasonix 按自身 `getcwd()`(符号链接已解析)存 session,而 `reasonixSessionFile` 编码原始 cwd — 在 macOS 上 `/tmp`→`/private/tmp`,导致 resume 找不到文件、静默开新会话。修复:`realpathSync(cwd)` 后再编码 + 回归测试(`reasonixRuntime.test.ts`)。修复后一轮 + `--resume` 二轮跑通,`session stable: true` ✓
  - **未验证(全栈缺口)**:dev:e2e 的 web 端 @dev-bot 收发一轮 + resume——docker 缺失导致 DB/Redis 起不来,留给合并后 CI/有 docker 的环境。
- **2026-08-02 — NAS 真机全栈验证(部署到真实 NAS 环境)** — 修复文件经 tar-over-ssh 同步回本 worktree,本地 452/452 测试过、typecheck 过:
  - 部署:`docker-compose --profile app up -d --build` 成功,server 容器 healthy HTTP 200;daemon 用 repo 源码(`tsx src/daemon/index.ts`)连 server。
  - **根因 debug(三点)**:① STARTUP_NUDGE 没被 envelope 包裹 → reasonix 把 wake 当编码任务陷入工具探测(实测 150s / 61 次 tool_dispatch);② 无 `--max-steps` → planner/executor 无限自转,进程不退出,daemon 卡在等 `proc "exit"`;③ stream-json 逐 token 增量(`text` 一个字符一条)→ 活动面板一字节一行。
  - **修复(已在 NAS 真机验证)**:`runtimeInstructionEnvelope(systemPrompt, text)` 包裹 wake;`--max-steps 3`;`oneShotWake: true → false`(走普通 nudge 路径);`text` 增量丢弃(`message` 事件是终稿)、`reasoning` 按换行聚合 flush、`message` 作为完整回复。NAS 测试 10/10 过 + typecheck 过。
  - **遗留 session 路径 bug(回本地后修复)**:NAS 上 home 目录是 bind mount(内核 getcwd 不解析),reasonix 用逻辑路径编码而 `realpathSync` 得到底层卷路径 → resume 找不到文件、每轮 fresh session。修复:`findReasonixSessionFile()` 按 session id 全量搜索 `projects/*/sessions/` 兜底(与路径编码无关,双平台都找到)+ 回归测试。
  - **待办**:PR 合并 → GitHub Release v0.15.0 → NAS 正式 daemon 换 `npx @fancyboi999/open-tag-daemon@latest`(重启生效)。
- **2026-08-02 — v1.19.1 升级 + 一轮修复审查**(本机 reasonix 升级到 v1.19.1,用户审改后全量验证):
  - 事件流、`--max-steps`/`--resume`/`--permission-mode`、effort 白名单、`doctor --json` 结构与 v1.18.0 一致;`--show-thinking` 仍不发 `reasoning` 事件;resume 续链 session_id 稳定 ✓
  - **版本行为差异(PWD vs getcwd,已实测确认)**:v1.18.0 用 `getcwd()`(macOS 解析符号链接 → `-private-tmp`;Linux 不解析 bind mount → `-var-services`),v1.19.1 改用 **LOGICAL cwd(honor `PWD` env)**——对照实验:cwd=/tmp/rxA 而 PWD=/private/tmp/rxA 时 session 存到 `-private-tmp-rxA`。故 v1.18.0 的 realpath 修复在 v1.19.1 是反的;用户改为直接编码 cwd + runTurn 已固定 PWD=opts.cwd → 与 v1.19.1 精确匹配;`findReasonixSessionFile` 兜底两者。
  - 用户新增修复(已审):reasonix skills 目录注册(global `~/.reasonix/skills` + 项目 `.reasonix/skills`,实测模型能加载)、`parseReasonixModels` 从 `config.default_model` 解析默认(两版都 `is_default:false`,实测 v1.19.1 真机输出 4 模型 + hy3-ioa 正确标默认)。
  - 测试 454/454 过、typecheck 过。
- **2026-08-02 — 线上 bug:`--max-steps 3` 让回复发不出去(本 worktree 内诊断+修复)** — obsidian_r(@meteorchen 的 Obsidian Vault agent)收到 "lint" / "需要先改配置文件给了权限才能跑吗？" 后动态显示执行完但没有正文回复。查 `~/.reasonix/projects/-Users-meteorchen-Documents-Obsidian Vault/sessions/*.events.jsonl`:两轮都是 `message check` → `message decide` → 干活(lint)后撞 `--max-steps 3` 上限,reasonix 注入 "Do not call any more tools — …synthesize a final answer" 禁止再调工具,agent 没机会执行 `open-tag message send`,最终汇总只留在会话里没发到频道(不是解析问题——工具活动都正常渲染;UI 的 reply preview 也刻意只显示活动不把 runtime 文本当正文)。修复:`--max-steps 3 → 10`(留足 check→decide→干活→send 协议循环,仍能终止失控自转);同步 reasonixRuntime.ts 注释 / 单测断言 / CHANGELOG / ARCHITECTURE。测试过、typecheck 过。
- **2026-08-02 — 观察期:上限设为 `--max-steps 100`** — 与用户讨论后决定:livelock 必然持续刷 `tool_dispatch`,上限只要存在就必然命中,所以值可以放大以减少对真实任务的误切;同时 envelope 修复后上限可能已冗余(从未单独验证过)。策略:**改 100 观察一段时间**——新增 `MAX_STEPS = 100` 常量 + `MAX_STEPS_REACHED_MARKER` 检测(reasonix 注入的 "tool-call round limit" 句),命中时 `cb.log.warn` 记录。观察期后:若从未触发 → 上限冗余,可移除(需真机确认自终止);若触发 → 上限仍必要,保留。同步代码注释 / 单测(含 cap 检测用例)/ CHANGELOG / ARCHITECTURE。测试过、typecheck 过。
