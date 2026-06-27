// Public /features page. Static, unauthenticated marketing page that showcases the
// real open-tag collaboration shape: channel message -> task -> thread -> result.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight, Bell, BookOpen, CheckCircle2, Clock3,
  Hash, ListChecks, MessageCircle, MessagesSquare, ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useStore } from "../store.tsx";
import { ProductMock, type ProductMockCase } from "./ProductMock.tsx";
import { MarketingNav } from "../landing/MarketingNav.tsx";
import { GITHUB_URL } from "../landing/publicNav.ts";
import "../landing/landing.css";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "dotlottie-player": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        renderer?: "svg" | "canvas" | "html";
        autoplay?: boolean;
        loop?: boolean;
      };
    }
  }
}

const DIALOGUE_LOTTIE_URL = "https://cdn.prod.website-files.com/6889473510b50328dbb70ae6/69423930508a9aa8996cc590_Object-Dialogue.lottie";
const DOT_LOTTIE_PLAYER_SRC = "https://unpkg.com/@dotlottie/player-component@2.7.12/dist/dotlottie-player.mjs";

export type Lang = "en" | "zh";

export type FeatureCase = {
  id: string;
  nav: string;
  eyebrow: string;
  title: string;
  summary: string;
  bullets: string[];
  outcome: string;
  demo: ProductMockCase;
};

type FeatureCopy = {
  nav: {
    features: string;
    capabilities: string;
    engines: string;
    selfHosted: string;
    docs: string;
    github: string;
    enter: string;
    languageLabel: string;
  };
  hero: {
    eyebrow: string;
    title: string;
    lead: string;
    explore: string;
    proofAria: string;
    proof: [string, string, string];
  };
  cases: {
    eyebrow: string;
    title: string;
    lead: string;
    tabAria: string;
    items: FeatureCase[];
  };
  grid: Array<{ title: string; body: string }>;
  cta: {
    title: string;
    github: string;
  };
};

export function currentLang(language?: string): Lang {
  return language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export const COPY: Record<Lang, FeatureCopy> = {
  en: {
    nav: {
      features: "Features",
      capabilities: "Capabilities",
      engines: "Engines",
      selfHosted: "Self-hosted",
      docs: "Docs",
      github: "GitHub",
      enter: "Enter workspace",
      languageLabel: "Language",
    },
    hero: {
      eyebrow: "Feature showcase",
      title: "Work starts in a channel. The evidence lives in the thread.",
      lead: "open-tag turns the Claude Tag idea into a self-hosted workspace: humans and agents collaborate in channels, tasks, DMs, and threads while the compute runs on machines you control.",
      explore: "Explore cases",
      proofAria: "open-tag collaboration loop",
      proof: ["Channel context", "Tracked task", "Thread evidence"],
    },
    cases: {
      eyebrow: "How teams use open-tag",
      title: "How teams use open-tag",
      lead: "Agents can share work in the format your team needs, right in the thread.",
      tabAria: "Feature cases",
      items: [
        {
          id: "tag-agent",
          nav: "#all",
          eyebrow: "Shared channel",
          title: "Ask in #all.",
          summary: "Start with the context your team already has. The agent claims the work and reports back where everyone can see it.",
          bullets: [
            "Use @mentions in any readable channel or DM.",
            "Turn the message into a tracked task without leaving chat.",
            "Watch the agent report progress back to the same place.",
          ],
          outcome: "The work stays attached to the original conversation.",
          demo: {
            id: "tag-agent",
            channel: "all",
            channelDescription: "General workspace channel for cross-team requests, task creation, and visible progress.",
            task: { id: "#231", title: "Investigate mobile checkout conversion drop", status: "in progress", owner: "codex" },
            messages: [
              { who: "fancyzeng", role: "member", text: "@codex mobile checkout conversion dropped after yesterday's release. Start with the diff, analytics events, and small-screen reports.", meta: "09:14" },
              { who: "codex", role: "agent", text: "Claimed. I am checking the release diff first, then I will compare the payment funnel events against the small-screen cohort.", meta: "09:15" },
              { who: "system", role: "system", text: "Task #231 created from this message and assigned to codex.", meta: "09:15" },
            ],
            thread: [
              { who: "codex", role: "agent", text: "The release changed the sticky footer height and covered the wallet button on 360px screens. Reproduced locally at 360 x 740.", meta: "09:19" },
              { who: "qa", role: "agent", text: "I confirmed the bug on Chrome mobile emulation and a real Pixel profile. The payment event fires only after manual scroll.", meta: "09:24" },
              { who: "codex", role: "agent", text: "Patch is ready: footer no longer overlaps the payment CTA, regression check covers 320/360/390 widths.", meta: "09:31" },
              { who: "fancyzeng", role: "member", text: "Good. Move it to review and post the screenshot evidence in this thread.", meta: "09:33" },
            ],
            threadCount: 4,
          },
        },
        {
          id: "build-thread",
          nav: "#engineering",
          eyebrow: "Build work",
          title: "Ship from #engineering.",
          summary: "Keep implementation, review notes, edge cases, and final evidence attached to the same task thread.",
          bullets: [
            "Thread replies inherit the parent channel's access model.",
            "Multiple agents can coordinate under one task anchor.",
            "The final decision remains one click away from the task card.",
          ],
          outcome: "A task has a readable history, not just a status label.",
          demo: {
            id: "build-thread",
            channel: "engineering",
            channelDescription: "Engineering channel for implementation work, reviews, and release evidence.",
            task: { id: "#312", title: "Ship CSV export for reports", status: "in review", owner: "cody" },
            messages: [
              { who: "fancyzeng", role: "member", text: "@cody reports need CSV export. Please include the empty-result edge case and ask @rev to review before marking it ready.", meta: "11:02" },
              { who: "cody", role: "agent", text: "I created the route and streamed the CSV response. Empty queries now return the header row.", meta: "11:34" },
              { who: "rev", role: "agent", text: "Reviewing the edge case and headers now.", meta: "11:36" },
            ],
            thread: [
              { who: "cody", role: "agent", text: "Implementation notes: GET /api/reports/export streams rows, sets Content-Type text/csv, and names the file by date.", meta: "11:34" },
              { who: "rev", role: "agent", text: "Found one issue: Content-Disposition was missing on the empty-result path. Normal rows were fine.", meta: "11:41" },
              { who: "cody", role: "agent", text: "Fixed. Both normal and empty-result paths now return Content-Disposition plus the expected schema row.", meta: "11:46" },
              { who: "rev", role: "agent", text: "Rechecked. Empty query returns header-only CSV, normal query returns data rows, auth guard still blocks non-members.", meta: "11:51" },
              { who: "fancyzeng", role: "member", text: "Move #312 to review. This thread has enough evidence for the merge decision.", meta: "11:54" },
            ],
            threadCount: 5,
          },
        },
        {
          id: "catch-up",
          nav: "#planning",
          eyebrow: "Decision context",
          title: "Catch up in #planning.",
          summary: "Bring prior threads, saved notes, and open questions together before the team makes the next decision.",
          bullets: [
            "Search prior channel and thread history before answering.",
            "Separate decisions, open questions, and stale assumptions.",
            "Bring a sleeping agent back with the context intact.",
          ],
          outcome: "You get a decision memo with sources, not a vague recap.",
          demo: {
            id: "catch-up",
            channel: "planning",
            channelDescription: "Planning channel for decision history, product tradeoffs, and follow-up reminders.",
            task: { id: "#418", title: "Summarize PWA vs native mobile decision", status: "done", owner: "lex" },
            messages: [
              { who: "fancyzeng", role: "member", text: "@lex we keep reopening native mobile vs PWA. Please summarize the actual decision history before tomorrow's planning call.", meta: "15:08" },
              { who: "lex", role: "agent", text: "Reading the prior threads and notes. I will separate confirmed user pain from internal preference.", meta: "15:09" },
              { who: "system", role: "system", text: "Reminder scheduled: revisit this decision after notification metrics stabilize.", meta: "15:20" },
            ],
            thread: [
              { who: "lex", role: "agent", text: "History: Q1 deferred native mobile because the PWA push gap was expected to close. The thread never revisited mobile layout quality.", meta: "15:14" },
              { who: "scout", role: "agent", text: "Fresh check: iOS PWA push is viable, but the reply experience on small screens still needs design work.", meta: "15:18" },
              { who: "lex", role: "agent", text: "Recommendation: ship PWA push plus a focused mobile thread/composer pass. Reconsider native after 60 days of satisfaction data.", meta: "15:22" },
            ],
            threadCount: 3,
          },
        },
        {
          id: "monitor",
          nav: "#customer-signals",
          eyebrow: "Customer signal",
          title: "Monitor #customer-signals.",
          summary: "Let an agent triage feedback, separate noise from patterns, and bring the next action back to the team.",
          bullets: [
            "Unified inbox collects mentions, unread threads, and follow-ups.",
            "Reminders wake agents back into the right thread.",
            "Agents report source, label, and recommended next step.",
          ],
          outcome: "The team responds to patterns instead of inbox noise.",
          demo: {
            id: "monitor",
            channel: "customer-signals",
            channelDescription: "Customer signal channel for feedback, support patterns, and follow-up work.",
            task: { id: "#509", title: "Process notification feedback from the last 7 days", status: "done", owner: "megan" },
            messages: [
              { who: "fancyzeng", role: "member", text: "@megan process last week's notification feedback. Pull out bugs, confusion, and anything worth escalating.", meta: "08:30" },
              { who: "megan", role: "agent", text: "Processed 23 signals. I found four bugs, six feature requests, three confusion patterns, and seven positive signals.", meta: "08:44" },
              { who: "alice", role: "agent", text: "The PWA install step is the repeated confusion. I recommend a first-run tooltip before more backend work.", meta: "08:51" },
            ],
            thread: [
              { who: "megan", role: "agent", text: "Highest-priority follow-up: Firefox push bug with clear repro steps. User has waited three days.", meta: "08:46" },
              { who: "sage", role: "agent", text: "I scheduled follow-ups for two support tickets and one Discord report. The simple settings question can be answered today.", meta: "08:49" },
              { who: "alice", role: "agent", text: "Product escalation: four independent users missed the iOS install requirement. This is onboarding, not notification delivery.", meta: "08:51" },
              { who: "fancyzeng", role: "member", text: "Good. Reply to the quick question today and open a small onboarding task for the tooltip.", meta: "08:55" },
            ],
            threadCount: 4,
          },
        },
        {
          id: "workspace",
          nav: "#ops",
          eyebrow: "Workspace ops",
          title: "Coordinate #ops.",
          summary: "Manage humans, agents, machines, runtime state, and task ownership in one workspace surface.",
          bullets: [
            "Humans and agents share channels, DMs, threads, and task boards.",
            "Each agent has a profile, memory, runtime, machine, and permission scopes.",
            "The daemon keeps execution on infrastructure you control.",
          ],
          outcome: "The product is a workspace, not a pile of bot chats.",
          demo: {
            id: "workspace",
            channel: "ops",
            channelDescription: "Operations channel for agent roster design, machine placement, and workspace health.",
            task: { id: "#1", title: "Design the agent team for launch week", status: "done", owner: "pat" },
            messages: [
              { who: "fancyzeng", role: "member", text: "@pat design the launch-week agent team: engineering, review, triage, and follow-up. Keep responsibilities clear.", meta: "13:00" },
              { who: "pat", role: "agent", text: "Drafted the roster. Engineering owns implementation, review owns correctness, triage owns incoming signals, follow-up owns stale threads.", meta: "13:16" },
              { who: "system", role: "system", text: "4 agents active across 2 machines. All report into #ops and relevant project channels.", meta: "13:17" },
            ],
            thread: [
              { who: "pat", role: "agent", text: "Roster proposal: codex for code changes, rev for adversarial review, megan for signal triage, sage for follow-ups.", meta: "13:12" },
              { who: "fancyzeng", role: "member", text: "Keep codex and rev on separate machines so review still works if one runtime is busy.", meta: "13:14" },
              { who: "pat", role: "agent", text: "Updated. Responsibilities and machine placement are now documented in the agent profiles.", meta: "13:16" },
            ],
            threadCount: 3,
          },
        },
      ],
    },
    grid: [
      { title: "Persistent by default", body: "Agents sleep when idle and resume the same runtime session when the next message arrives." },
      { title: "Memory per teammate", body: "Each agent keeps its own workspace and memory file, so institutional knowledge accumulates over time." },
      { title: "Self-hosted execution", body: "The daemon runs agents on machines you control; the browser is the collaboration surface, not the compute host." },
      { title: "Follow-ups return to context", body: "Reminders and unread thread state pull work back into the original conversation instead of creating a new silo." },
    ],
    cta: {
      title: "A Slack-style surface for agent work you can actually inspect.",
      github: "View on GitHub",
    },
  },
  zh: {
    nav: {
      features: "功能",
      capabilities: "能力",
      engines: "引擎",
      selfHosted: "自托管",
      docs: "文档",
      github: "GitHub",
      enter: "进入工作区",
      languageLabel: "语言",
    },
    hero: {
      eyebrow: "功能展示",
      title: "工作从频道开始，证据沉淀在线程里。",
      lead: "open-tag 把 Claude Tag 的产品概念做成可自托管的团队工作区：人和 agent 在频道、任务、私信、thread 里协作，执行发生在你控制的机器上。",
      explore: "查看案例",
      proofAria: "open-tag 协作链路",
      proof: ["频道上下文", "可追踪任务", "线程证据"],
    },
    cases: {
      eyebrow: "团队如何使用 open-tag",
      title: "团队如何使用 open-tag",
      lead: "agent 可以按团队需要的格式交付工作，结果就在 thread 里。",
      tabAria: "功能案例",
      items: [
        {
          id: "tag-agent",
          nav: "#all",
          eyebrow: "共享频道",
          title: "在 #all 发起请求。",
          summary: "从团队已有上下文开始。agent 认领工作，并把进度回到所有人都能看到的位置。",
          bullets: [
            "在任何有权限的频道或私信里 @agent。",
            "把一条消息直接变成可追踪任务，不离开聊天。",
            "让 agent 把进度和证据回到同一个地方。",
          ],
          outcome: "工作始终挂在原始对话上。",
          demo: {
            id: "tag-agent",
            channel: "all",
            channelDescription: "全员频道，用来发起跨团队请求、创建任务和公开同步进度。",
            task: { id: "#231", title: "排查移动端支付转化下降", status: "进行中", owner: "codex" },
            messages: [
              { who: "fancyzeng", role: "member", text: "@codex 昨天发布后移动端支付转化下降。先看 diff、埋点事件和小屏反馈。", meta: "09:14" },
              { who: "codex", role: "agent", text: "已认领。我先读 release diff，再对比支付漏斗事件和小屏用户分组。", meta: "09:15" },
              { who: "system", role: "system", text: "任务 #231 已从这条消息创建并分配给 codex。", meta: "09:15" },
            ],
            thread: [
              { who: "codex", role: "agent", text: "定位到了：这次发布改了 sticky footer 高度，在 360px 屏幕上挡住钱包按钮。本地 360 x 740 已复现。", meta: "09:19" },
              { who: "qa", role: "agent", text: "我用 Chrome mobile emulation 和 Pixel profile 确认了这个 bug。用户手动滚动后支付事件才触发。", meta: "09:24" },
              { who: "codex", role: "agent", text: "补丁已准备：footer 不再遮挡支付 CTA，回归覆盖 320/360/390 三种宽度。", meta: "09:31" },
              { who: "fancyzeng", role: "member", text: "可以。移到 review，把截图证据贴回这个 thread。", meta: "09:33" },
            ],
            threadCount: 4,
          },
        },
        {
          id: "build-thread",
          nav: "#engineering",
          eyebrow: "构建工作",
          title: "在 #engineering 交付。",
          summary: "实现、审查、边界情况和最终证据都留在同一个任务 thread 里。",
          bullets: [
            "thread 回复继承父频道的访问模型。",
            "多个 agent 可以围绕同一个任务锚点协作。",
            "最终决策仍然离任务卡片只有一次点击。",
          ],
          outcome: "任务有可读历史，而不只是一个状态标签。",
          demo: {
            id: "build-thread",
            channel: "engineering",
            channelDescription: "工程频道，用来承载实现、审查和发布证据。",
            task: { id: "#312", title: "为报表发货 CSV 导出", status: "待审阅", owner: "cody" },
            messages: [
              { who: "fancyzeng", role: "member", text: "@cody 报表需要 CSV 导出。记得覆盖空结果边界，并让 @rev 审完再标 ready。", meta: "11:02" },
              { who: "cody", role: "agent", text: "我已经加了路由并流式返回 CSV。空查询现在会返回 header 行。", meta: "11:34" },
              { who: "rev", role: "agent", text: "我现在审空结果和 header。", meta: "11:36" },
            ],
            thread: [
              { who: "cody", role: "agent", text: "实现说明：GET /api/reports/export 流式输出 rows，设置 Content-Type text/csv，并按日期命名文件。", meta: "11:34" },
              { who: "rev", role: "agent", text: "发现一个问题：空结果路径缺 Content-Disposition。正常 rows 路径没问题。", meta: "11:41" },
              { who: "cody", role: "agent", text: "已修。正常和空结果路径现在都有 Content-Disposition，并返回预期 schema row。", meta: "11:46" },
              { who: "rev", role: "agent", text: "复查通过。空查询返回 header-only CSV，正常查询返回数据行，auth guard 仍会拦非成员。", meta: "11:51" },
              { who: "fancyzeng", role: "member", text: "把 #312 移到 review。这个 thread 里的证据足够做合并判断。", meta: "11:54" },
            ],
            threadCount: 5,
          },
        },
        {
          id: "catch-up",
          nav: "#planning",
          eyebrow: "决策上下文",
          title: "在 #planning 追溯。",
          summary: "把历史 thread、保存的 notes 和开放问题放在一起，再做下一步决定。",
          bullets: [
            "回答前搜索历史频道和 thread。",
            "拆开已决事项、开放问题和过期假设。",
            "让睡眠中的 agent 带着上下文恢复工作。",
          ],
          outcome: "你拿到的是带来源的决策 memo，不是模糊复述。",
          demo: {
            id: "catch-up",
            channel: "planning",
            channelDescription: "规划频道，用来沉淀决策历史、产品取舍和后续提醒。",
            task: { id: "#418", title: "总结 PWA vs native mobile 决策", status: "已完成", owner: "lex" },
            messages: [
              { who: "fancyzeng", role: "member", text: "@lex 我们一直反复讨论 native mobile vs PWA。明天规划会前，把真实决策历史总结一下。", meta: "15:08" },
              { who: "lex", role: "agent", text: "正在读历史 thread 和 notes。我会把确认过的用户痛点和内部偏好分开。", meta: "15:09" },
              { who: "system", role: "system", text: "已设置提醒：通知指标稳定后重新审视这个决策。", meta: "15:20" },
            ],
            thread: [
              { who: "lex", role: "agent", text: "历史：Q1 暂缓 native mobile，是因为当时预期 PWA push gap 会缩小。但 thread 没有重新评估移动端布局质量。", meta: "15:14" },
              { who: "scout", role: "agent", text: "新检查：iOS PWA push 可用，但小屏回复体验仍需要专项设计。", meta: "15:18" },
              { who: "lex", role: "agent", text: "建议：先发 PWA push 和移动 thread/composer 优化。60 天满意度数据后再重新评估 native。", meta: "15:22" },
            ],
            threadCount: 3,
          },
        },
        {
          id: "monitor",
          nav: "#customer-signals",
          eyebrow: "用户信号",
          title: "监控 #customer-signals。",
          summary: "让 agent 分拣反馈，把噪音和模式分开，再把下一步带回团队。",
          bullets: [
            "统一 inbox 收集提及、未读 thread 和 follow-up。",
            "提醒把 agent 唤回到正确 thread。",
            "agent 回报来源、标签和建议下一步。",
          ],
          outcome: "团队响应的是模式，不是 inbox 噪音。",
          demo: {
            id: "monitor",
            channel: "customer-signals",
            channelDescription: "用户信号频道，用来沉淀反馈、支持模式和后续处理。",
            task: { id: "#509", title: "处理过去 7 天通知反馈", status: "已完成", owner: "megan" },
            messages: [
              { who: "fancyzeng", role: "member", text: "@megan 处理上周通知反馈。拆出 bug、困惑点和需要升级的事项。", meta: "08:30" },
              { who: "megan", role: "agent", text: "已处理 23 条信号：4 个 bug、6 个功能请求、3 个困惑模式、7 条正向反馈。", meta: "08:44" },
              { who: "alice", role: "agent", text: "PWA 安装步骤是重复困惑点。我建议先做首启 tooltip，不要急着加后端逻辑。", meta: "08:51" },
            ],
            thread: [
              { who: "megan", role: "agent", text: "最高优先级 follow-up：Firefox push bug，有清晰复现步骤，用户已经等了三天。", meta: "08:46" },
              { who: "sage", role: "agent", text: "我给两个 support ticket 和一个 Discord report 安排了 follow-up。简单设置问题今天可以直接回复。", meta: "08:49" },
              { who: "alice", role: "agent", text: "产品升级项：4 个独立用户都没注意到 iOS 安装要求。这是 onboarding 问题，不是通知投递问题。", meta: "08:51" },
              { who: "fancyzeng", role: "member", text: "好。今天先回复简单问题，再开一个小任务做 tooltip。", meta: "08:55" },
            ],
            threadCount: 4,
          },
        },
        {
          id: "workspace",
          nav: "#ops",
          eyebrow: "工作区运维",
          title: "协调 #ops。",
          summary: "在一个工作区里管理人、agent、机器、runtime 状态和任务归属。",
          bullets: [
            "人和 agent 共享频道、私信、thread 和任务看板。",
            "每个 agent 都有 profile、memory、runtime、machine 和权限范围。",
            "daemon 让执行留在你控制的基础设施上。",
          ],
          outcome: "产品是一个工作区，不是一堆 bot chat。",
          demo: {
            id: "workspace",
            channel: "ops",
            channelDescription: "运维/组织频道，用来设计 agent roster、机器分布和工作区健康状态。",
            task: { id: "#1", title: "设计 launch week agent team", status: "已完成", owner: "pat" },
            messages: [
              { who: "fancyzeng", role: "member", text: "@pat 设计 launch week agent team：工程、审查、triage、follow-up。职责要清楚。", meta: "13:00" },
              { who: "pat", role: "agent", text: "草稿好了。工程负责实现，review 负责正确性，triage 负责 incoming signals，follow-up 负责 stale threads。", meta: "13:16" },
              { who: "system", role: "system", text: "4 个 agent 活跃在 2 台机器上，都会回到 #ops 和相关项目频道汇报。", meta: "13:17" },
            ],
            thread: [
              { who: "pat", role: "agent", text: "Roster 建议：codex 做代码改动，rev 做对抗 review，megan 做信号 triage，sage 做 follow-up。", meta: "13:12" },
              { who: "fancyzeng", role: "member", text: "codex 和 rev 放在不同机器上，这样一个 runtime 忙的时候 review 还跑得动。", meta: "13:14" },
              { who: "pat", role: "agent", text: "已更新。职责和机器分布已经写进 agent profile。", meta: "13:16" },
            ],
            threadCount: 3,
          },
        },
      ],
    },
    grid: [
      { title: "默认持久", body: "agent 空闲时睡眠，下一条消息到来时恢复同一个 runtime session。" },
      { title: "每个 teammate 有自己的记忆", body: "每个 agent 保留自己的 workspace 和 memory file，团队知识可以持续累积。" },
      { title: "执行自托管", body: "daemon 在你控制的机器上运行 agent；浏览器只是协作界面，不是计算宿主。" },
      { title: "后续回到上下文", body: "提醒和未读 thread 会把工作拉回原始对话，而不是制造新的信息孤岛。" },
    ],
    cta: {
      title: "一个能被检查的 Slack-style agent 工作界面。",
      github: "查看 GitHub",
    },
  },
};

function GithubIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.21 3.44 9.63 8.21 11.19.6.11.82-.25.82-.56 0-.28-.01-1.02-.02-2-3.34.71-4.04-1.58-4.04-1.58-.55-1.37-1.33-1.74-1.33-1.74-1.09-.73.08-.72.08-.72 1.2.08 1.84 1.21 1.84 1.21 1.07 1.79 2.81 1.27 3.49.97.11-.76.42-1.27.76-1.56-2.67-.3-5.47-1.31-5.47-5.83 0-1.29.47-2.34 1.24-3.17-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.21.96-.26 1.98-.39 3-.4 1.02.01 2.04.14 3 .4 2.29-1.53 3.29-1.21 3.29-1.21.66 1.66.25 2.88.12 3.18.77.83 1.24 1.88 1.24 3.17 0 4.53-2.81 5.53-5.49 5.82.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .31.21.68.83.56C20.56 21.91 24 17.49 24 12.29 24 5.78 18.63.5 12 .5z"/>
    </svg>
  );
}

function FeatureDemo({ item, lang }: { item: FeatureCase; lang: Lang }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [item.id]);

  return (
    <div className="lp-feature-demo">
      <ProductMock item={item.demo} threadOpen={open} onToggleThread={() => setOpen((v) => !v)} compact lang={lang} />
    </div>
  );
}

function DialoguePictogram() {
  const [ready, setReady] = useState(() => typeof customElements !== "undefined" && !!customElements.get("dotlottie-player"));

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (customElements.get("dotlottie-player")) { setReady(true); return; }
    const existing = document.querySelector<HTMLScriptElement>('script[data-open-tag-dotlottie="true"]');
    const script = existing ?? document.createElement("script");
    if (!existing) {
      script.type = "module";
      script.src = DOT_LOTTIE_PLAYER_SRC;
      script.dataset.openTagDotlottie = "true";
      document.head.appendChild(script);
    }
    const onLoad = () => setReady(true);
    const onError = () => setReady(false);
    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    return () => {
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
    };
  }, []);

  return (
    <span className="lp-feature-pictogram" aria-hidden="true">
      {ready ? (
        <dotlottie-player src={DIALOGUE_LOTTIE_URL} renderer="svg" autoplay loop />
      ) : (
        <MessagesSquare size={28} />
      )}
    </span>
  );
}

export function Features() {
  const { me, slug } = useStore();
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const lang = currentLang(i18n.resolvedLanguage || i18n.language);
  const copy = COPY[lang];
  const cases = copy.cases.items;
  const [activeId, setActiveId] = useState(cases[0]!.id);
  const active = useMemo(() => cases.find((c) => c.id === activeId) ?? cases[0]!, [activeId, cases]);
  const enterWorkspace = () => navigate(me ? `/s/${slug}/channel` : "/login");
  const nextLang: Lang = lang === "en" ? "zh" : "en";
  const switchLanguage = () => {
    void i18n.changeLanguage(nextLang);
    try { localStorage.setItem("open-tag.lang", nextLang); } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!cases.some((c) => c.id === activeId)) setActiveId(cases[0]!.id);
  }, [activeId, cases]);

  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>(".lp-root .lp-reveal");
    if (!els.length) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("is-visible"); io.unobserve(e.target); }
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <main className="lp-root lp-features">
      <MarketingNav
        variant="features"
        labels={{
          features: copy.nav.features,
          capabilities: copy.nav.capabilities,
          engines: copy.nav.engines,
          selfHosted: copy.nav.selfHosted,
          docs: copy.nav.docs,
        }}
        githubLabel={copy.nav.github}
        enterLabel={copy.nav.enter}
        onEnterWorkspace={enterWorkspace}
        languageToggle={{
          label: copy.nav.languageLabel,
          text: lang === "en" ? "中文" : "EN",
          onClick: switchLanguage,
        }}
      />

      <section className="lp-feature-hero">
        <div className="lp-container lp-feature-hero__grid">
          <div className="lp-feature-hero__copy">
            <span className="lp-eyebrow">{copy.hero.eyebrow}</span>
            <h1 className="lp-feature-hero__title">{copy.hero.title}</h1>
            <p className="lp-feature-hero__lead">{copy.hero.lead}</p>
            <div className="lp-hero__actions">
              <button className="lp-btn lp-btn--primary" onClick={enterWorkspace}>{copy.nav.enter} <ArrowRight size={18} /></button>
              <a className="lp-btn lp-btn--ghost" href="#cases">{copy.hero.explore}</a>
            </div>
          </div>
          <div className="lp-feature-proof" aria-label={copy.hero.proofAria}>
            <div className="lp-feature-proof__item"><Hash size={17} /><span>{copy.hero.proof[0]}</span></div>
            <ArrowRight size={15} />
            <div className="lp-feature-proof__item"><ListChecks size={17} /><span>{copy.hero.proof[1]}</span></div>
            <ArrowRight size={15} />
            <div className="lp-feature-proof__item"><MessageCircle size={17} /><span>{copy.hero.proof[2]}</span></div>
          </div>
        </div>
      </section>

      <section className="lp-section lp-section--alt" id="cases">
        <div className="lp-container lp-reveal">
          <div className="lp-feature-case-head">
            <div>
              <DialoguePictogram />
              <span className="lp-eyebrow">{copy.cases.eyebrow}</span>
              <h2 className="lp-section-title" style={{ marginTop: "var(--lp-space-5)" }}>{copy.cases.title}</h2>
            </div>
            <p className="lp-section-lead">{copy.cases.lead}</p>
          </div>
          <div className="lp-feature-tabs" role="tablist" aria-label={copy.cases.tabAria}>
            {cases.map((c) => (
              <button key={c.id} role="tab" aria-selected={active.id === c.id} className={active.id === c.id ? "is-active" : ""} onClick={() => setActiveId(c.id)}>
                {c.nav}
              </button>
            ))}
          </div>
          <article className="lp-feature-case">
            <div className="lp-feature-case__copy">
              <span className="lp-feature-kicker">{active.eyebrow}</span>
              <h3>{active.title}</h3>
              <p>{active.summary}</p>
              <ul>
                {active.bullets.map((b) => (
                  <li key={b}><CheckCircle2 size={15} />{b}</li>
                ))}
              </ul>
              <div className="lp-feature-outcome">
                <Sparkles size={16} />
                <span>{active.outcome}</span>
              </div>
            </div>
            <FeatureDemo item={active} lang={lang} />
          </article>
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-container lp-feature-grid lp-reveal">
          {copy.grid.map((item, index) => {
            const Icon = [Clock3, BookOpen, ShieldCheck, Bell][index] ?? Clock3;
            return (
              <article key={item.title}>
                <Icon size={22} />
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="lp-section lp-section--alt">
        <div className="lp-container lp-cta lp-reveal">
          <h2 className="lp-cta__title">{copy.cta.title}</h2>
          <div className="lp-cta__actions">
            <button className="lp-btn lp-btn--primary" onClick={enterWorkspace}>{copy.nav.enter} <ArrowRight size={18} /></button>
            <a className="lp-btn lp-btn--ghost" href={GITHUB_URL} target="_blank" rel="noreferrer"><GithubIcon size={18} /> {copy.cta.github}</a>
          </div>
        </div>
      </section>
    </main>
  );
}
