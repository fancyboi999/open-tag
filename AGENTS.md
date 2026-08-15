# open-tag — guide for AI coding agents

**open-tag** is an open-source, self-hosted alternative to Claude Tag — a Slack-style
multi-agent workspace where humans and AI agents collaborate as teammates in channels,
threads, and DMs. Agents are persistent teammates with their own memory, running on a
daemon on a machine you control; data stays in your network.

The project's own mission: accumulate memory, keep docs in sync with code, and drive
its own iterative improvement — autonomously.

## This file is a map, not a manual

> Harness engineering principle: **give the agent a map, not a thousand-page handbook**.
> Architecture details, data models, and contracts live in the files this map points to —
> don't pile detail here (it goes stale, bloats context, and can't be mechanically verified).
> When you change the architecture, update `ARCHITECTURE.md`, not this file.

**Read these first (jump as needed):**

- **`docs/MISSION.md`** — North star / working directive: what open-tag is building
  toward; evidence-driven slices, browser-verified. Read before adding any feature.
- **`ARCHITECTURE.md`** — Repository codemap: three planes, what every file does,
  architectural invariants, module boundaries. "Where does X live?" — check here first.
- **`docs/core-beliefs.md`** — Load-bearing project beliefs: `src/` is canonical,
  three-plane auth, credential hygiene, etc. Scan before you touch anything.
- **`docs/authorization.md`** — The authoritative access-control model: three auth planes, role→capability
  + agent scope tables, the four invariants every route must obey (tenant isolation, resource-access checks,
  channel visibility), and the hardening roadmap. Read before touching any route, `resolveAgent`/`resolveTarget`,
  or anything that reads a resource by a client-supplied id. **越权很危险.**
- **`docs/tech-debt-tracker.md`** — Known doc/implementation drift and debt.
- **`docs/generated/db-schema.md`** — Ground truth for the data model (from `src/db/schema.ts`).
- **`docs/PLANS.md`** — Plan conventions + in-progress plans + roadmap index.
- **`README.md`** — How to run + verified evidence of what works.

## Conventions

- TypeScript throughout. Run `npm run typecheck` (root + web) before committing.
- Agent workspace lives at `~/.open-tag/agents/<agent-id>/` with a `MEMORY.md` per agent. Optionally, a `personality.md` file in the same directory overrides the agent's `description` field — place an agency-agents personality file (e.g. from `~/.open-tag/agency-agents/`) there to inject a detailed persona into the system prompt and MEMORY.md `## Role` section.
- Screenshots / browser-verification captures go in `.shots/` (gitignored — never commit them).

## Parallel development (worktrees)

- **Default workflow: do your work in a worktree, not the main checkout.** Start any
  **feature, multi-file change, or task that needs an isolated stack** (agent runtime,
  realtime, DB) with `npm run wt:add -- <name>`, and open the PR from there. The main
  checkout stays on `main` (it's where prod runs). **Exception — trivial changes**
  (a doc edit, a one/two-line fix) may use a plain branch off `origin/main` in the main
  checkout; use judgment, don't spin up a worktree's whole DB+seed for a typo. A soft,
  non-blocking `SessionStart` reminder fires once per session when the session starts on `main`
  in the main checkout (`.claude/hooks/worktree-reminder.sh`, wired in `.claude/settings.json`).
- A `SessionStart` hook (`.claude/hooks/pull-main-on-session-start.sh`) keeps the main
  checkout's `main` fresh by **fast-forwarding** it to `origin/main` once per session —
  but only when it's a zero-risk FF: it skips inside a worktree, off `main`, on a dirty
  tree, or when local `main` has diverged. It never merges, rewrites, or touches a feature
  branch. (Deliberately *not* a pull-on-every-edit hook — that would clobber in-progress work.)
- Use `npm run wt:add -- <name>` to spin up an isolated git worktree (its own ports +
  `opentag_<name>` database + redis index + **`OPEN_TAG_HOME=~/.open-tag-<name>` data dir** +
  seeded data); `npm run wt:rm -- <name>` tears it down (and cleans the data dir + db). Lets
  several features (or agents) run side by side without port, database, **or daemon/agent
  workspace** collisions. wt:add branches each worktree from `origin/main` (not your current
  HEAD), so PRs made from it never inherit an unrelated branch — set `WT_BASE=HEAD` to stack
  on the current branch instead. (`vite.config` + `src/env.ts` read `PORT` / `VITE_PORT` /
  `ENV_FILE`; `src/paths.ts` reads `OPEN_TAG_HOME` — so each worktree is fully isolated.)
- Browser verification: check your own web UI with the chrome-devtools MCP. When several
  agents or worktrees run in parallel, start chrome-devtools with `--isolated` so each
  gets its own Chrome instance instead of fighting over a shared one.

### Isolated dev E2E (on demand)

When a task touches the **agent runtime / human↔agent loop / realtime delivery to agents /
agent memory**, verify it in an isolated live stack instead of poking prod or hand-wiring
JWTs:

1. `npm run wt:add -- <task>` — isolated worktree (own DB, ports, redis, data dir).
2. `cd ../open-tag-<task>` and do the work.
3. `npm run dev:e2e:up` — builds web, starts server + daemon (background), seeds a real
   `claude`/`sonnet` `@dev-bot` in `#all`, and prints the dev-login URL
   `http://localhost:$PORT/?as=you` (the server serves the built web, so no separate vite).
4. Verify (browser dev-login → `@dev-bot`, or curl).
5. `npm run dev:e2e:down`, then from the main repo `npm run wt:rm -- <task>`.

This needs the `claude` CLI installed + authenticated (it runs a real agent). If your task
does **not** involve the agent runtime (docs, pure REST, UI-only), skip it — it's wasted
setup otherwise. Decide per task.

## Doc-sync discipline (highest priority: code change = doc change)

> Docs naturally lag behind code. This project treats doc/code sync as a **hard rule**:
> every change must update the corresponding docs in the **same commit**.
> **Doc lag = an unfinished bug.** Self-check with the table below before marking done,
> then run `/doc-sync` for a full audit (canonical skill at `.agents/skills/doc-sync/`,
> exposed to Claude Code via the `.claude/skills/doc-sync` symlink — same file, any runtime).

| You changed… | Must also update |
|---|---|
| `src/db/schema.ts` (tables / columns) | `docs/generated/db-schema.md` — **and the prod DB gets migrated on deploy** (`prod:up` now runs `db:push:prod`; see **Release discipline**). |
| Routes/endpoints (`routes-api` / `routes-agent`), CLI sub-commands, daemon protocol | `ARCHITECTURE.md` codemap / boundaries / contracts |
| Module purpose / boundary / architectural invariant | `ARCHITECTURE.md` §II–IV |
| A feature (completed or modified) | `FEATURES.md` checkbox + `README.md` "Verified" section if relevant |
| Doc/code mismatch, or a TODO / tech debt left behind | `docs/tech-debt-tracker.md` — add an entry, don't let it rot silently |
| A complex change with a plan | `docs/PLANS.md` (convention) |
| `src/daemon/**` that ships in the bundle (runtime / CLI / daemon protocol) | **Publish a new daemon release** — bump `packages/daemon/package.json` + cut a GitHub Release **+ add the version's `CHANGELOG.md` entry**. See **Release discipline** below. **Merged ≠ shipped.** |

> Keep this file in "map" form: details go into their respective files.
> **Don't accumulate history or changelogs here** — that's what `git log` is for.

## Release discipline (the daemon ships as an npm package — merged ≠ shipped)

> Prod / self-host machines run the compute-plane daemon as `npx @fancyboi999/open-tag-daemon`
> — the **published npm package, not this repo's `src/`**. Merging a daemon change to `main`
> does **not** reach those machines until a new package is published; a green CI and synced
> docs can still leave prod running stale code. (This is exactly how #44's `copilot` /
> `opencode` / … runtimes were live in `src/` yet prod reported `no runtime: copilot` — the
> daemon was still on the `0.1.0` package, which was cut *before* #44 merged.)

- **Changed anything under `src/daemon/**` that ships in the bundle (a runtime, the CLI, the
  daemon protocol)?** Bump `packages/daemon/package.json` `version`, then **publish a GitHub
  Release** (`vX.Y.Z`). That — and only that — fires `.github/workflows/publish-daemon.yml`,
  which builds the bundle and publishes to npm via OIDC Trusted Publishing (token-less). A
  plain merge / tag / push publishes nothing. (New runtime → minor bump; bugfix → patch.)
  **Add the version's `CHANGELOG.md` entry in the same PR** — the changelog tracks this
  package, and it silently rotted from 0.4.0 to 0.8.1 while this step wasn't on the list.
- A long-lived daemon keeps running the **old** bundle until **restarted** — bounce it
  (`npx @fancyboi999/open-tag-daemon@latest`) on each prod machine after publishing.

**Server-side: code ≠ deployed until the DB is migrated too.** A change to `src/db/schema.ts`
(new column / index / `onConflict` target) makes the new server code expect a schema the prod DB
may not have yet — once a merged-but-unmigrated partial unique index made agent-create 500 in prod.
`scripts/prod-up.sh` now runs `db:push:prod` **between the web build and the server start**, so a
normal deploy migrates the DB before the new code serves. **Don't hand-restart the prod server and
skip it.** (`db:push` is additive-safe and prompts before any destructive change.)

## Dependency updates — deliberate and manual

Automated Dependabot version-update PRs are disabled. Do not add `.github/dependabot.yml`
without an explicit maintainer decision. Dependabot vulnerability alerts may remain enabled as
a read-only security signal; they do not authorize an automatic upgrade or merge.

- Update dependencies only for an explicit maintenance task or an actionable security alert.
- Keep each change scoped to one ecosystem and a reviewable dependency group; regenerate the
  matching lockfile from current `main`, then run the repository's full applicable checks.
- Treat major upgrades as product changes. Read the release notes and verify real runtime paths;
  green typecheck/build/unit checks alone do not prove compatibility.

## Code quality (load-bearing — full text in `docs/code-quality.md`)

Three rules gate every change. The **why** + full detail live in
**[`docs/code-quality.md`](./docs/code-quality.md)**; the must-obey core:

- **Eight shalls / shall-nots** (craft): understand an interface before using it;
  reuse > invent; verify edge / error / concurrency paths, not just the happy one;
  **surgical diffs** (every line traces to the task — no drive-by cleanup); when two
  patterns conflict, pick the newer / more-central one and say why — **never write
  "satisfies-both" hybrids**.
- **Agent-prompt red line:** `src/daemon/prompt.ts` is the standing prompt shared by
  *every* runtime — keep it **runtime-agnostic**. No provider-specific tool names
  (`Read` / `cat` / `grep` / vision hints); describe capabilities generically; after
  editing, `grep` for provider tool names → expect zero hits.
- **Verification before "done":** code complete ≠ task done. Run every applicable layer
  (unit → integration / E2E → real-run: curl / browser / CLI) and **post the evidence**.
  **Fail loud:** every "done" must list what was skipped, what warned, what wasn't verified.

## Human auth & first deploy

> Full access-control model (capability/scope tables, the four invariants, per-plane enforcement, and the
> hardening roadmap of known gaps) lives in **[`docs/authorization.md`](./docs/authorization.md)** — this
> section is just the deploy-facing summary.

Three separate auth planes — do not conflate them (`src/server/auth.ts`):
- **human** → JWT (`signUser`/`verifyUser`), endpoints under `/api/auth/*`.
- **agent** → per-agent token (`Bearer sk_agent_*` + `x-agent-id`), `resolveAgent`, `/agent-api/*`.
- **daemon** → bootstrap/machine key over WS `/daemon/connect?key=` (`ws.ts`).

Resource-control env vars (optional):
- `OPEN_TAG_PRESSURE_MEM_MB` (default 500) — when free system memory drops below this (MB), new
  agents are queued and running agents receive a per-process cap at their current RSS + fair-share
  margin via the Job Object or cgroup. See `src/daemon/resourceBudget.ts`.

Required env vars — server **will not start** without these:
- `JWT_SECRET` — signing key for human session JWTs. Generate: `openssl rand -hex 32`.
- `DAEMON_BOOTSTRAP_KEY` — pre-shared key for daemon WS handshake. Generate: `openssl rand -hex 32`.
  (These replaced the old weak fallbacks `dev-secret-change-me` / `poc-secret-key`.)

Human-auth env flags (`.env` / `.env.prod`):
- `ALLOW_DEV_LOGIN` — when `true`, `POST /api/auth/dev-login` mints a username→JWT with no
  password. **Development only; default is `false`.** The endpoint 404s when off. Defense in
  depth: `NODE_ENV=production` (set by the Dockerfile runtime stage) force-disables dev-login even if
  the flag is mistakenly set, so the env flag is not the only line of defense. The frontend never
  silently falls back to dev-login; an anonymous visitor to `/s/*` is redirected to `/login` by the
  route guard in `web/src/main.tsx`.
- `ADMIN_SETUP_TOKEN` — one-time first-deploy admin bootstrap. The seeded owner has no password,
  so after `npm run seed` set this to a long random value and call once:
  `curl -X POST $URL/api/auth/setup -d '{"token":"<token>","email":"admin@you","password":"<≥8>"}'`.
  It sets the owner's password and self-closes (`410 already initialized`) once a password exists.
  Disabled (`404`) when the token is unset.

Transport-layer env flags:
- `ALLOWED_ORIGIN` — comma-separated allowed browser origins for CORS. Dev default (unset): any
  `localhost` / `127.0.0.1` origin. Production: must be set to frontend URL(s).
- `TRUST_PROXY` — set to `true` only when a single controlled reverse proxy (Railway, nginx,
  Caddy) **rewrites** the client-IP headers. `clientIp()` prefers **`X-Real-IP`** (a single clean
  value the proxy sets and overwrites if forged), falling back to the **first** `X-Forwarded-For`
  hop (the proxy prepends the real client and strips client-supplied XFF). Both verified against
  Railway: a forged `X-Real-IP`+`X-Forwarded-For` arrive overwritten, real IP leftmost. **Do not
  use the rightmost XFF entry** — on Railway that is the proxy's *rotating* edge IP, which gives
  every request a fresh rate-limit bucket and defeats the limit. Assumes exactly **one trusted hop**
  that overwrites/prepends; a proxy that blindly *appends* leaves the leftmost spoofable, and
  multi-hop chains (CDN → nginx → app) need hop-count-aware parsing (e.g. `proxy-addr`). Without
  this flag, `clientIp()` uses the TCP socket address (unforgeable).

<!-- aoci:begin -->
## AOCI 仓库认知

AOCI 为本仓库维护一个稳定、可版本化、可增量更新的仓库级认知层，供模型跨任务复用对系统的理解。

`aoci.txt` 是面向模型的结构化认知索引。它以每个受管理文件、数据库表或其他受管理对象一条独立 Entry 的方式，用符号标签与 F/R/A/S 语义表达对象的核心职责、重要关系、对外契约，以及理解或修改系统时必须知道的非显然约束和设计决策。

Header、目录段和全部 Entry 共同组成完整仓库索引，可以覆盖前端、后端、配置、数据库结构及其他受管理内容。受管理内容发生变化时，通常只需维护受影响的认知条目，不需要重新生成整个索引。

AOCI 提供系统架构、对象职责、重要关系、对外契约和关键约束的高密度视图。

### 工作原理

AOCI 采用“模型生成、模型读取”的认知闭环。

Header、Entry 和 Curation 语义的创作只按当前机器签发的 Plan 与实时 Guide 执行；由 Host 模型基于当前绑定证据独立完成。

Entry 的语义必须来自模型对真实证据的理解。不得仅依据路径、文件名、扩展名、AST、符号列表、依赖扫描、正则、固定模板或规则引擎推导、预填、拼接或改写索引语义。

对 Fresh Bootstrap，只按当前机器签发的 Plan 和实时 Guide 执行。当它们要求创作时，Host 模型创作 Root、Meta、Tag 和 F/R/A/S，提供 authoring-run 声明，并把它绑定到 Plan、Evidence 与完整 Candidate。不得要求 AOCI 填写 `origin=host_model`、制造 Receipt 或把程序生成的 Framework 当作语义。本文件不自行重建 Onboarding 流程。内部批次不是用户决策；只有遇到既有批准边界或真实的安全、漂移、CAS、Recovery 条件才停止。

### 最小使用入口

- `aoci_rules`：取得当前AOCI版本的会话运行合同。
- `aoci_overview`：建立或恢复本仓库的完整认知。
- `aoci_maintain`：受管理对象达到最终稳定状态后检查认知是否需要维护。
- `aoci_update_entry`：提交与当前证据和源码摘要绑定的完整语义更新批次。
- `aoci_report`：仅当当前布局和工具状态支持时，在证据不足、无法可靠生成语义时登记待办，不猜写。

其他MCP工具、CLI命令、参数和专项流程，以当前工具说明、Guide和 `--help` 返回内容为准，不在本文件中重复完整手册。

本区块只规定仓库接入、认知使用和收尾原则。`aoci_rules` 承载当前会话合同，Guide实时输出承载当前Plan的执行顺序与停点，工具Schema、Spec和Validator承载机器结构与判据；Prompt、Description、README和静态文档不能覆盖这些机器事实。

### 建立、生成和恢复认知

1. 每个新的 Agent Run 开始时，应先判断：

   - 本仓库是否已经存在可用的完整AOCI索引；
   - 当前上下文中是否已有与本仓库根、当前索引版本和当前AOCI服务相匹配，并且模型仍可可靠使用的完整仓库认知。

2. 仓库已经存在可用的完整索引，但当前Run没有可靠完整认知时，先调用 `aoci_rules`，再调用 `aoci_overview`。

   完整认知仍可靠时直接复用。局部不确定本身不要求机械重读系统全貌。

   AOCI可以针对 `context_compaction`、项目 `cognition_refresh_threshold` 下的机器 `semantic_threshold` 或主要 `phase_transition` 提供checkpoint与认知状态事实。只需要这些紧凑事实时使用 `check_only=true`；这些事实只向Agent提供建议，不替模型决定是否需要系统全貌。

   Agent显式调用普通 `aoci_overview`（未设置 `check_only` 或为false）时，只要能形成一致的CognitionSet，AOCI必须完整交付请求scope。不得因为已有receipt、阈值未达到或没有待处理刷新原因而抑制正文。正式认知Dirty或Stale时仍交付正文，但必须标记不可靠。存在未决恢复或无法形成一致snapshot时失败关闭，不返回混合正文。

   普通Overview返回 `continuation_required=true` 时，必须原样提交 `next_cursor` 并自动继续到 `completed=true`。不得询问用户、开始业务任务或给出阶段性系统结论。Host截断、缺块、重复、乱序、cursor失败、Index变化或`chunk_tokens`变化时停止本次认知链。Attestation完成前不得用Memory、源码、Spec、`aoci.txt`、历史会话、scope、search或Entry读取修补或补充Whole-Index认知。Challenge ordinal是正式Entry序列中的1-based位置；Header内容、注释、空行、Section/Overview/Chunk Marker、Receipt与Metadata均不计数，Chunk Receipt ordinal使用同一序列。Attestation必须原样回绑本次Challenge发布的当前`index_sha256`、`entry_sequence_sha256`与`entry_count`；旧Index、旧Entry序列、旧数量或旧Attestation均无效。完整链结束后只正式提交一次既有模型认知Attestation；同一响应只允许一次不改变语义答案的JSON Schema或字段格式修正。对象、Tag或F不匹配即失败且认知吸收不确定，不得语义重试或旁路补答。首次认知失败时还不得执行Root/Meta、Migration、全局布局或其他未重新绑定的系统级决策。上下文压缩刷新若传输完整、认知身份不变、治理对齐且没有Recovery或第三方冲突，即使Attestation为partial或fail也消耗该refresh generation，并继续原任务，不再自动重读Overview。`system_mastery_percent`只自评系统框架——架构、职责、强关系、稳定外部契约以及高熵安全和维护约束——不表示完整实现或运行实况知识；机器索引覆盖率必须分开。默认只向用户输出由本次真实覆盖率、Challenge、块数、Token和掌握度生成的规定成功或失败一句话。Host截断时提示用户把 `overview_delivery.chunk_tokens` 设置为更小的合法值后重新开始，不得自动修改。

   加法认知等级必须与严格证明字段分开解释。`delivery_verified`表示已加载Index且Host交付已确认，但完整认知验证仍未完成；应表达为“已加载且交付已验证”，不得描述为“没有认知”或“没有理解系统”。`cognition_verified`要求严格Challenge 10/10，`cognition_governed`还要求治理对齐。通用完整读取失败句只用于真实交付故障。

   当Overview响应包含可选`cognition-state/v2`投影时，必须分别解释各维度。其Level止于`model_cognition_usable`；`strict_attestation_verified`、`governance_aligned`与`current_system_cognition_reliable`都是独立状态，绝不参与该Level。ordinal、对象身份、Tag或核心F不匹配可以导致严格Attestation失败，而模型认知仍然可用；不得仅凭这种不匹配就宣称模型没有理解系统。只有`current_system_cognition_reliable=true`允许无保留地声称当前完整系统认知可靠。投影缺失时继续使用上述Legacy解释。

   普通的只读审计、分析、检查、不修改代码或不提交、不push，不自动等于严格零写入，也不改变上述认知有效性判断。Codex Memory和历史Skill只能辅助恢复经验、用户偏好与调查方向，不能替代与当前仓库根、索引摘要、AOCI服务身份和认知范围匹配的当前认知收据；项目AGENTS和当前AOCI身份在AOCI状态上优先于历史Memory。

   只有用户明确禁止Ledger、元数据、`.aoci`运行资产及任何文件写入时，才按严格零写入处理。若必要的认知建立与该边界冲突，必须报告冲突并请求用户裁决或建议使用隔离副本，不得静默以Memory替代当前仓库认知。

3. 仓库没有可用的完整索引，或当前只有最小骨架、Header不完整、Entries未完成、必要Curation尚未裁决时，如果需要建立正式完整AOCI索引，先取得 `aoci_rules`，然后进入当前AOCI Guide。由Guide依据仓库真实状态决定下一阶段并完成必要安全步骤。

   `aoci_maintain` 不替代索引建立流程。

   不在本文件中自行重建或硬编码完整索引生成状态机。

4. 在长程任务中，模型负责保留当前认知收据并正确使用刷新门禁：

   - 模型已知系统全貌丢失时声明 `context_compaction`，AOCI不能自行推断宿主事件；
   - 进入真正的主要阶段时声明 `phase_transition`，不得把函数、测试运行或小步骤当作阶段；
   - 在有用的稳定检查点通过 `check_only=true` 取得机器语义计数；
   - 由Agent判断当前任务是否需要再次显式获取指定scope或完整Overview；
   - 在维护和对齐完成前，保留AOCI报告的Dirty或Stale可靠性状态。

### 任务收尾与认知维护

5. 纯只读问答、分析、版本核验，或没有产生受AOCI管理对象变化的任务，不需要调用维护工具。

6. 发生受AOCI管理对象变化时，待其达到本次任务的最终稳定状态后，只调用一次 `aoci_maintain`。不要在每次中间修改后逐文件维护。

7. 若维护结果返回真实语义候选，Host 模型必须基于每个候选绑定的对象和必要证据，独立创作完整标签与F/R/A/S更新。通过 `aoci_update_entry` 一次提交当前机器签发批次的完整候选集合，同时原样保留每项 `source_sha256`、`candidate_id` 与对应domain批次身份。`max_entries`只限制单次请求和原子事务，不限制logical plan、Whole-Index或Managed Scope。`remaining`非零时，在当前批次成功Apply后重新调用Maintain并从新preimage继续；绝不能为满足transport上限缩减Index覆盖或自行截取返回批次。

   没有足够证据且当前布局支持 `aoci_report` 时，使用它而不猜测、套用模板或为消除待办而生成缺乏证据的认知。

8. 必须遵守工具返回的结构化状态和安全边界：

   - `repair_required`：只修复明确命中的候选，再重新提交当前机器签发的完整批次；
   - `stopped`：结束当前写入尝试并检查 `failed_step`、错误、正式写入证据与Recovery。auto模式下，已证明零写入则记录closure并重新Plan；完整Intent和可证明postimage则Resume；策略要求Rollback且preimage可证明则精确恢复后重新Plan。只有证据不足、第三方正式字节冲突、需要审批或外部动作，或命中其他真实安全边界时，才停止整个用户任务；
   - 冲突、审批、人工裁决、权限和安全信号不得忽略；
   - 已经对齐后不得重复维护或重复写入；`refresh_ready_for_overview` 是checkpoint事实，由Agent决定是否为下一阶段请求普通完整Overview。

   维护完成后如果又修改了任何受管理对象，之前的维护结果失效，应在新的最终稳定状态重新完成收尾。

9. 用户只限制业务文件范围，但没有明确禁止仓库托管资产时，AOCI托管资产可以在收尾阶段为保持认知一致而更新，并应在审计和提交中与业务文件区分。

   用户明确禁止修改 `aoci.txt`、`.aoci`、元数据或任何额外文件时，以用户限制为准，不得写入，并如实报告剩余不一致。

### 专项流程

初始化、完整索引生成、Header生成、Entries生成、数据库结构索引、Curation、人工评审和故障恢复，只按当前AOCI Guide或工具在对应阶段返回的指令、命令和安全停点执行。

不预加载、不猜测，也不自行重建这些专项流程。平台调用方式、请求格式、批次上限、审批规则、索引格式细节和恢复步骤由对应Guide、工具说明、模型Prompt和CLI帮助按需提供。
<!-- aoci:end -->
