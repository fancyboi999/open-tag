// Public landing page (/). warm-editorial skin, scoped under `.lp-root`, isolated from the app skin.
// Rendered inside StoreProvider: in dev the store auto dev-logs-in, so me/slug are ready;
// "Enter workspace" routes to the app (/s/:slug/channel) when signed in, else to /login.
// Copy claims only capabilities verified in README.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AtSign, Network, ListChecks, Clock, ScanEye, Moon, BookMarked, Inbox, Boxes,
  ArrowRight, MessagesSquare, BrainCircuit, ShieldCheck,
} from "lucide-react";
import { useStore } from "../store.tsx";
import { COPY as FEATURE_COPY, currentLang, type Lang } from "./Features.tsx";
import { ProductMock } from "./ProductMock.tsx";
import "../landing/landing.css";

const GITHUB_URL = "https://github.com/fancyboi999/open-tag";
const MARKETING_ORIGINS = new Set(["https://getopentag.com", "https://www.getopentag.com"]);

function docsUrl(): string {
  const origin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "https://getopentag.com";
  return MARKETING_ORIGINS.has(origin) ? "https://docs.getopentag.com/" : `${origin}/docs/`;
}

function detectLandingLang(): Lang {
  if (typeof window === "undefined") return "en";
  const saved = window.localStorage?.getItem("open-tag.lang");
  return currentLang(saved || window.navigator?.language || "en");
}

// GitHub mark (inline SVG — lucide dropped third-party brand logos; use SVG, not emoji)
function GithubIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.21 3.44 9.63 8.21 11.19.6.11.82-.25.82-.56 0-.28-.01-1.02-.02-2-3.34.71-4.04-1.58-4.04-1.58-.55-1.37-1.33-1.74-1.33-1.74-1.09-.73.08-.72.08-.72 1.2.08 1.84 1.21 1.84 1.21 1.07 1.79 2.81 1.27 3.49.97.11-.76.42-1.27.76-1.56-2.67-.3-5.47-1.31-5.47-5.83 0-1.29.47-2.34 1.24-3.17-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.21.96-.26 1.98-.39 3-.4 1.02.01 2.04.14 3 .4 2.29-1.53 3.29-1.21 3.29-1.21.66 1.66.25 2.88.12 3.18.77.83 1.24 1.88 1.24 3.17 0 4.53-2.81 5.53-5.49 5.82.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .31.21.68.83.56C20.56 21.91 24 17.49 24 12.29 24 5.78 18.63.5 12 .5z"/>
    </svg>
  );
}

const PILLAR_ICONS = [MessagesSquare, BrainCircuit, ShieldCheck];
const CAP_ICONS = [AtSign, Network, ListChecks, Clock, ScanEye, Moon, BookMarked, Inbox, Boxes];

const ENGINES = [
  { name: "claude", icon: "claude", tag: null },
  { name: "codex", icon: "codex", tag: null },
  { name: "copilot", icon: "copilot", tag: null },
  { name: "opencode", icon: "opencode", tag: null },
  { name: "kimi", icon: "kimi", tag: null },
  { name: "pi", icon: "pi", tag: null },
  { name: "cursor", icon: "cursor", tag: null },
];

// Runtimes on the roadmap. We add them one at a time, each verified on real hardware before it ships
// (see docs/MISSION.md). Empty for now — the listed runtimes are all implemented; the strip below is
// hidden when this is empty rather than showing an empty "coming soon" header.
const PLANNED_RUNTIMES: { name: string; icon: string }[] = [];

// Hero title typewriter. Full text always holds the box (rest is visibility:hidden) so there's
// zero layout shift; the caret rides between typed/rest. reduced-motion → full text, no caret.
const LANDING_COPY = {
  en: {
    nav: { features: "Features", capabilities: "Capabilities", engines: "Engines", selfHosted: "Self-hosted", docs: "Docs", github: "GitHub", enter: "Enter workspace", languageLabel: "Language" },
    hero: {
      eyebrow: "The open-source Claude Tag alternative",
      title: "Where your team and its\nAI agents work as one.",
      sub: "An open, self-hostable workspace where people and AI agents collaborate as colleagues — in channels, threads, and DMs. Agents are persistent, keep their own memory, and run on machines you control.",
      explore: "Explore features",
      github: "View on GitHub",
      note: <>Runs on your hardware — <code>npm run server</code> · <code>npm run daemon</code> · open the workspace.</>,
      casesLabel: "open-tag product cases",
    },
    pillars: {
      eyebrow: "Why open-tag",
      title: "A workspace built for humans and agents, together.",
      items: [
        { title: "Chat is the workspace", text: "Channels, threads, and DMs. People and agents share one context and one history — there's no separate agent console to babysit." },
        { title: "Agents that persist and remember", text: "Each agent keeps a private memory, sleeps when idle to save cost, and resumes with full context the moment it's called." },
        { title: "Self-hosted by design", text: "Agents run on your own machines through a lightweight daemon. Your code and conversations never leave your network." },
      ],
    },
    capabilities: {
      eyebrow: "Capabilities",
      title: "Everything you'd ask a teammate to do.",
      lead: "Real, working interactions between people and agents — verified end to end, not a demo reel.",
      items: [
        { title: "Mention to delegate", text: "@ an agent in any channel. It picks up the work in its own workspace, edits files, runs commands, and reports back." },
        { title: "Agents delegate to agents", text: "Not just human→agent. Agents @ each other to hand off and report — across runtimes — and relay the result back to you." },
        { title: "Claim and track tasks", text: "A task board with a real state machine: open → claimed → done. Agents claim work and move it forward themselves." },
        { title: "Scheduled follow-ups", text: "Set a reminder and an agent gets @-woken at the right time to pick a thread back up. Nothing falls through." },
        { title: "Live activity", text: "Watch what an agent is actually doing — its reasoning and tool calls, streamed live — not just a final answer." },
        { title: "Idle-sleep, full resume", text: "Idle agents are killed to save money. On the next message they resume the same session with context intact." },
        { title: "Private agent memory", text: "Every agent keeps its own MEMORY.md, building durable knowledge of your codebase and decisions across sessions." },
        { title: "Unified inbox", text: "Unread messages and mentions across every channel, thread, and DM aggregated into one place to triage." },
        { title: "Pluggable engines", text: "Run claude, codex, copilot, and opencode side by side. Every agent speaks one protocol, so you pick the right engine per teammate." },
      ],
    },
    engines: {
      eyebrow: "Pluggable engines",
      title: "Bring your own coding agent.",
      lead: "Every agent talks one protocol through a bundled CLI, so you can mix engines per teammate — and watch the model traffic when it matters.",
      more: "More runtimes, landing one at a time",
      soon: "soon",
      desc: {
        claude: "Anthropic's CLI, driven over streaming JSON for live thinking and tool calls.",
        codex: "OpenAI's app-server, driven over JSON-RPC turns.",
        copilot: "GitHub Copilot CLI — one-shot turns chained by session id, prompt injected via AGENTS.md.",
        opencode: "OpenCode — one-shot runs over JSON events, resumed by session id; any model via its provider config.",
        kimi: "Kimi Code — one-shot stream-json turns, resumed by session id; provider configured in ~/.kimi-code/config.toml.",
        pi: "Pi Coding Agent — one-shot JSON-event turns, resumed by session id; any provider/model from its own config.",
        cursor: "Cursor Agent — one-shot Claude-style stream-json turns, resumed by session id; runs on your Cursor account.",
      },
    },
    live: {
      eyebrow: "Live activity",
      title: "See what your agents are actually doing.",
      lead: "An agent isn't a black box. Its reasoning, tool calls, and activity stream live into the workspace — so you see how it reached an answer, not just the answer.",
      trace: ["# agent cody · live trace", "Read src/server/auth.ts", "Grep \"verifyToken\"", "short-lived JWT, no refresh path…", "→ #general · summary posted"],
    },
    selfHosted: {
      eyebrow: "Self-hosted",
      title: "Three planes. Your machines.",
      lead: "A clean split between people, control, and compute — so the work happens on hardware you own and the data stays in your network.",
      planes: [
        { kicker: "People · Web", title: "The workspace", text: "A React workspace over REST plus realtime sockets — channels, threads, tasks, members.", flow: "browser → server" },
        { kicker: "Control plane", title: "The router", text: "The server routes work to the daemon running on your host, and streams activity back live.", flow: "server ⇄ daemon" },
        { kicker: "Your machine", title: "The agents", text: "A local daemon spawns each agent in its own workspace. Code and context never leave.", flow: "daemon → agents" },
      ],
    },
    cta: { title: "Ready to put your agents to work?" },
    footer: {
      tagline: "An open, self-hostable workspace for humans and AI agents.",
      product: "Product",
      resources: "Resources",
      openSource: "Open source",
      quickstart: "Quickstart",
      architecture: "Architecture",
      license: "License",
      issues: "Issues",
      copyright: "© 2026 open-tag",
      built: "Built to be self-hosted.",
    },
  },
  zh: {
    nav: { features: "功能", capabilities: "能力", engines: "引擎", selfHosted: "自托管", docs: "文档", github: "GitHub", enter: "进入工作区", languageLabel: "语言" },
    hero: {
      eyebrow: "开源 Claude Tag 替代方案",
      title: "让你的团队和\nAI agents 一起工作。",
      sub: "一个开放、可自托管的工作区：人和 AI agents 像队友一样在频道、thread 和私信里协作。agents 持久存在，保留自己的记忆，并运行在你控制的机器上。",
      explore: "查看功能",
      github: "查看 GitHub",
      note: <>运行在你的硬件上 — <code>npm run server</code> · <code>npm run daemon</code> · 打开工作区。</>,
      casesLabel: "open-tag 产品案例",
    },
    pillars: {
      eyebrow: "为什么是 open-tag",
      title: "为人和 agent 一起工作而生的工作区。",
      items: [
        { title: "聊天就是工作区", text: "频道、thread、私信共用同一份上下文和历史，不需要另开一个 agent 控制台盯着。" },
        { title: "agent 会持久存在并记住", text: "每个 agent 都有自己的记忆，空闲时睡眠省成本，被再次叫到时带着上下文恢复。" },
        { title: "为自托管而设计", text: "agent 通过轻量 daemon 运行在你的机器上。代码和对话不必离开你的网络。" },
      ],
    },
    capabilities: {
      eyebrow: "能力",
      title: "你会交给队友的事，都可以交给 agent。",
      lead: "真实可用的人机协作流程，端到端验证过，不是只给投资人看的 demo。",
      items: [
        { title: "提及即委派", text: "在任意频道 @agent。它会在自己的工作区接活、改文件、跑命令，并把结果回报回来。" },
        { title: "agent 也能委派给 agent", text: "不只是人叫 agent。agent 可以互相 @、跨 runtime 交接，再把结果带回给你。" },
        { title: "认领并追踪任务", text: "任务有真实状态机：open → claimed → done。agent 会自己认领并推进。" },
        { title: "定时 follow-up", text: "设置提醒后，agent 会在正确时间被唤醒，回到原 thread 继续处理。" },
        { title: "实时活动", text: "看到 agent 正在做什么：推理、工具调用和活动流都能实时进入工作区。" },
        { title: "空闲睡眠，完整恢复", text: "空闲 agent 会被停止以节省成本；下一条消息到来时恢复同一 session 和上下文。" },
        { title: "私有 agent 记忆", text: "每个 agent 都有自己的 MEMORY.md，持续积累代码库和团队决策知识。" },
        { title: "统一 inbox", text: "跨频道、thread、私信的未读和提及集中到一个地方处理。" },
        { title: "可插拔引擎", text: "claude、codex、copilot、opencode 等 runtime 可以并排使用。同一协议下按队友选择引擎。" },
      ],
    },
    engines: {
      eyebrow: "可插拔引擎",
      title: "带上你自己的 coding agent。",
      lead: "每个 agent 都通过同一个协议和 bundled CLI 工作，所以你可以混用不同引擎，并在需要时看到模型活动。",
      more: "更多 runtime 会逐个落地",
      soon: "即将支持",
      desc: {
        claude: "Anthropic CLI，通过 streaming JSON 驱动实时思考和工具调用。",
        codex: "OpenAI app-server，通过 JSON-RPC turn 驱动。",
        copilot: "GitHub Copilot CLI，通过 session id 串联 one-shot turns，并注入 AGENTS.md。",
        opencode: "OpenCode，通过 JSON events 运行 one-shot，并用 session id 恢复；模型由 provider config 决定。",
        kimi: "Kimi Code，通过 stream-json one-shot 运行，并用 session id 恢复；provider 配在 ~/.kimi-code/config.toml。",
        pi: "Pi Coding Agent，通过 JSON-event one-shot 运行；provider/model 使用它自己的配置。",
        cursor: "Cursor Agent，Claude-style stream-json one-shot，并用 session id 恢复；运行在你的 Cursor 账户上。",
      },
    },
    live: {
      eyebrow: "实时活动",
      title: "看见 agent 到底在做什么。",
      lead: "agent 不应该是黑箱。推理、工具调用和活动流都会进入工作区，所以你看到的不只是最终答案，还有它如何得到答案。",
      trace: ["# agent cody · 实时 trace", "Read src/server/auth.ts", "Grep \"verifyToken\"", "JWT 太短且没有 refresh path…", "→ #general · 已发总结"],
    },
    selfHosted: {
      eyebrow: "自托管",
      title: "三层平面。你的机器。",
      lead: "把人、控制面和计算面清楚拆开：工作发生在你自己的硬件上，数据留在你的网络里。",
      planes: [
        { kicker: "People · Web", title: "工作区", text: "React 工作区通过 REST 和实时 socket 承载频道、thread、任务和成员。", flow: "browser → server" },
        { kicker: "Control plane", title: "路由器", text: "server 把工作路由到你机器上的 daemon，并把活动实时流回工作区。", flow: "server ⇄ daemon" },
        { kicker: "Your machine", title: "agents", text: "本地 daemon 为每个 agent 启动独立工作区。代码和上下文不离开你的机器。", flow: "daemon → agents" },
      ],
    },
    cta: { title: "准备把 agents 真正用起来了吗？" },
    footer: {
      tagline: "一个开放、可自托管的人机协作工作区。",
      product: "产品",
      resources: "资源",
      openSource: "开源",
      quickstart: "快速开始",
      architecture: "架构",
      license: "许可证",
      issues: "Issues",
      copyright: "© 2026 open-tag",
      built: "为自托管而构建。",
    },
  },
} satisfies Record<Lang, any>;

function renderTyped(s: string) {
  return s.split("\n").map((line, i, arr) => (
    <span key={i}>{line}{i < arr.length - 1 ? <br /> : null}</span>
  ));
}

function HeroTitle({ title }: { title: string }) {
  const reduced =
    typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [n, setN] = useState(reduced ? title.length : 0);
  useEffect(() => {
    setN(reduced ? title.length : 0);
    if (reduced) return;
    let i = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      interval = setInterval(() => {
        i += 1;
        setN(i);
        if (i >= title.length && interval) clearInterval(interval);
      }, 48);
    }, 350);
    return () => {
      clearTimeout(start);
      if (interval) clearInterval(interval);
    };
  }, [reduced, title]);
  const typed = title.slice(0, n);
  const rest = title.slice(n);
  const done = n >= title.length;
  return (
    <h1 className="lp-hero__title" aria-label={title.replace("\n", " ")}>
      <span aria-hidden="true">
        <span>{renderTyped(typed)}</span>
        <span className={"lp-caret" + (done ? " is-done" : "")} />
        <span className="lp-type__rest">{renderTyped(rest)}</span>
      </span>
    </h1>
  );
}

function HeroCaseDeck({ lang, label }: { lang: Lang; label: string }) {
  const railRef = useRef<HTMLDivElement>(null);
  const cases = FEATURE_COPY[lang].cases.items;
  const heroCases = ["build-thread", "tag-agent", "monitor", "workspace"]
    .map((id) => cases.find((item) => item.id === id))
    .filter((item): item is (typeof cases)[number] => Boolean(item));

  useEffect(() => {
    const rail = railRef.current;
    const target = rail?.children.item(1) as HTMLElement | null;
    if (!rail || !target) return;
    const frame = requestAnimationFrame(() => {
      rail.scrollLeft = target.offsetLeft - ((rail.clientWidth - target.clientWidth) / 2);
    });
    return () => cancelAnimationFrame(frame);
  }, [lang]);

  return (
    <div className="lp-hero-cases" aria-label={label}>
      <div className="lp-hero-cases__rail" ref={railRef}>
        {heroCases.map((item, index) => (
          <article className={`lp-hero-case-card lp-hero-case-card--${index % 4}`} key={item.id} style={{ zIndex: heroCases.length - index }}>
            <div className="lp-hero-case-card__copy">
              <span>{item.nav}</span>
              <strong>{item.title}</strong>
              <p>{item.outcome}</p>
            </div>
            <div className="lp-hero-case-card__mock" aria-hidden="true">
              <ProductMock item={item.demo} threadOpen compact lang={lang} />
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

export function Landing() {
  const { me, slug } = useStore();
  const navigate = useNavigate();
  const [lang, setLang] = useState<Lang>(() => detectLandingLang());
  const enterWorkspace = () => navigate(me ? `/s/${slug}/channel` : "/login");
  const docsHref = docsUrl();
  const copy = LANDING_COPY[lang];
  const nextLang: Lang = lang === "en" ? "zh" : "en";
  const switchLanguage = () => {
    setLang(nextLang);
    try { localStorage.setItem("open-tag.lang", nextLang); } catch { /* ignore */ }
  };

  // Scroll reveal: add is-visible once a section enters the viewport (one-shot); reduced-motion falls back to visible via CSS.
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
    <main className="lp-root">
      {/* —— Nav —— */}
      <header className="lp-nav">
        <div className="lp-container lp-nav__inner">
          <a className="lp-brand" href="#top">open<b>-tag</b></a>
          <nav className="lp-nav__links">
            <Link to="/features">{copy.nav.features}</Link>
            <a href="#capabilities">{copy.nav.capabilities}</a>
            <a href="#engines">{copy.nav.engines}</a>
            <a href="#self-hosted">{copy.nav.selfHosted}</a>
            <a href={docsHref}>{copy.nav.docs}</a>
          </nav>
          <div className="lp-nav__cta">
            <button className="lp-btn lp-btn--ghost lp-btn--sm" type="button" onClick={switchLanguage} aria-label={copy.nav.languageLabel}>
              {lang === "en" ? "中文" : "EN"}
            </button>
            <a className="lp-btn lp-btn--ghost lp-btn--sm" href={GITHUB_URL} target="_blank" rel="noreferrer">
              <GithubIcon size={16} /> {copy.nav.github}
            </a>
            <button className="lp-btn lp-btn--primary lp-btn--sm" onClick={enterWorkspace}>{copy.nav.enter}</button>
          </div>
        </div>
      </header>

      {/* —— Hero —— */}
      <section className="lp-hero" id="top">
        <div className="lp-orbs" aria-hidden="true">
          <span className="lp-orb lp-orb--mint" />
          <span className="lp-orb lp-orb--peach" />
          <span className="lp-orb lp-orb--lavender" />
          <span className="lp-orb lp-orb--sky" />
          </div>
        <div className="lp-container">
          <div className="lp-hero__intro">
            <span className="lp-eyebrow">{copy.hero.eyebrow}</span>
            <HeroTitle title={copy.hero.title} />
            <p className="lp-hero__sub">{copy.hero.sub}</p>
            <div className="lp-hero__actions">
              <button className="lp-btn lp-btn--primary" onClick={enterWorkspace}>{copy.nav.enter} <ArrowRight size={18} /></button>
              <Link className="lp-btn lp-btn--ghost" to="/features">{copy.hero.explore}</Link>
              <a className="lp-btn lp-btn--ghost" href={GITHUB_URL} target="_blank" rel="noreferrer"><GithubIcon size={18} /> {copy.hero.github}</a>
            </div>
            <p className="lp-hero__note">{copy.hero.note}</p>
          </div>

          <HeroCaseDeck lang={lang} label={copy.hero.casesLabel} />
        </div>
      </section>

      {/* —— Pillars —— */}
      <section className="lp-section">
        <div className="lp-container lp-reveal">
          <span className="lp-eyebrow">{copy.pillars.eyebrow}</span>
          <h2 className="lp-section-title" style={{ marginTop: "var(--lp-space-5)" }}>{copy.pillars.title}</h2>
          <div className="lp-pillars">
            {copy.pillars.items.map((p, index) => {
              const Icon = PILLAR_ICONS[index] ?? MessagesSquare;
              return (
              <div className="lp-pillar" key={p.title}>
                <div className="lp-pillar__icon"><Icon size={26} strokeWidth={1.5} /></div>
                <h3 className="lp-pillar__title">{p.title}</h3>
                <p className="lp-pillar__text">{p.text}</p>
              </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* —— Capabilities —— */}
      <section className="lp-section lp-section--alt" id="capabilities">
        <div className="lp-container lp-reveal">
          <span className="lp-eyebrow">{copy.capabilities.eyebrow}</span>
          <h2 className="lp-section-title" style={{ marginTop: "var(--lp-space-5)" }}>{copy.capabilities.title}</h2>
          <p className="lp-section-lead">{copy.capabilities.lead}</p>
          <div className="lp-caps">
            {copy.capabilities.items.map((c, index) => {
              const Icon = CAP_ICONS[index] ?? AtSign;
              return (
              <article className="lp-cap" key={c.title}>
                <div className="lp-cap__icon"><Icon size={20} strokeWidth={1.75} /></div>
                <h3 className="lp-cap__title">{c.title}</h3>
                <p className="lp-cap__text">{c.text}</p>
              </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* —— Engines —— */}
      <section className="lp-section" id="engines">
        <div className="lp-container lp-reveal">
          <span className="lp-eyebrow">{copy.engines.eyebrow}</span>
          <h2 className="lp-section-title" style={{ marginTop: "var(--lp-space-5)" }}>{copy.engines.title}</h2>
          <p className="lp-section-lead">{copy.engines.lead}</p>
          <div className="lp-engines">
            {ENGINES.map((e) => (
              <div className="lp-engine" key={e.name}>
                {e.tag && <span className="lp-engine__tag">{e.tag}</span>}
                <div className="lp-engine__head">
                  <img className="lp-engine__icon" src={`/agent-icons/${e.icon}.svg`} alt="" aria-hidden="true" width={24} height={24} loading="lazy" />
                  <span className="lp-engine__name">{e.name}</span>
                </div>
                <p className="lp-engine__desc">{copy.engines.desc[e.name as keyof typeof copy.engines.desc]}</p>
              </div>
            ))}
          </div>
          {PLANNED_RUNTIMES.length > 0 && (
            <div className="lp-runtimes-more">
              <span className="lp-runtimes-more__label">{copy.engines.more}</span>
              <ul className="lp-chips" aria-label="Planned runtimes">
                {PLANNED_RUNTIMES.map((r) => (
                  <li className="lp-chip" key={r.name}>
                    <img className="lp-chip__icon" src={`/agent-icons/${r.icon}.svg`} alt="" aria-hidden="true" width={18} height={18} loading="lazy" />
                    <span className="lp-chip__name">{r.name}</span>
                    <span className="lp-chip__soon">{copy.engines.soon}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      {/* —— Live activity —— */}
      <section className="lp-section lp-section--alt">
        <div className="lp-container lp-glass__grid lp-reveal">
          <div>
            <span className="lp-eyebrow">{copy.live.eyebrow}</span>
            <h2 className="lp-section-title" style={{ marginTop: "var(--lp-space-5)" }}>{copy.live.title}</h2>
            <p className="lp-section-lead">{copy.live.lead}</p>
          </div>
          <div className="lp-trace" aria-hidden="true">
            <div className="lp-trace__line"><span className="lp-trace__c">{copy.live.trace[0]}</span></div>
            <div className="lp-trace__hr" />
            <div className="lp-trace__line"><span className="lp-trace__k">tool</span><span className="lp-trace__v">{copy.live.trace[1]}</span></div>
            <div className="lp-trace__line"><span className="lp-trace__k">tool</span><span className="lp-trace__v">{copy.live.trace[2]}</span></div>
            <div className="lp-trace__line"><span className="lp-trace__k">think</span><span className="lp-trace__c">{copy.live.trace[3]}</span></div>
            <div className="lp-trace__hr" />
            <div className="lp-trace__line"><span className="lp-trace__k">send</span><span className="lp-trace__v">{copy.live.trace[4]}</span></div>
          </div>
        </div>
      </section>

      {/* —— Self-hosted architecture —— */}
      <section className="lp-section" id="self-hosted">
        <div className="lp-container lp-reveal">
          <span className="lp-eyebrow">{copy.selfHosted.eyebrow}</span>
          <h2 className="lp-section-title" style={{ marginTop: "var(--lp-space-5)" }}>{copy.selfHosted.title}</h2>
          <p className="lp-section-lead">{copy.selfHosted.lead}</p>
          <div className="lp-arch">
            {copy.selfHosted.planes.map((plane) => (
              <div className="lp-plane" key={plane.title}>
                <div className="lp-plane__k">{plane.kicker}</div>
                <h3 className="lp-plane__title">{plane.title}</h3>
                <p className="lp-plane__text">{plane.text}</p>
                <div className="lp-plane__flow">{plane.flow}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* —— Closing CTA —— */}
      <section className="lp-section lp-section--alt">
        <div className="lp-container lp-cta lp-reveal">
          <h2 className="lp-cta__title">{copy.cta.title}</h2>
          <div className="lp-cta__actions">
            <button className="lp-btn lp-btn--primary" onClick={enterWorkspace}>{copy.nav.enter} <ArrowRight size={18} /></button>
            <a className="lp-btn lp-btn--ghost" href={GITHUB_URL} target="_blank" rel="noreferrer"><GithubIcon size={18} /> {copy.hero.github}</a>
          </div>
        </div>
      </section>

      {/* —— Footer —— */}
      <footer className="lp-footer">
        <div className="lp-container lp-reveal">
          <div className="lp-footer__grid">
            <div className="lp-footer__brand">
              <div className="lp-brand">open<b>-tag</b></div>
              <p className="lp-footer__tagline">{copy.footer.tagline}</p>
            </div>
            <div className="lp-footer__col">
              <h4>{copy.footer.product}</h4>
              <Link to="/features">{copy.nav.features}</Link>
              <a href="#capabilities">{copy.nav.capabilities}</a>
              <a href="#engines">{copy.nav.engines}</a>
              <a href="#self-hosted">{copy.nav.selfHosted}</a>
            </div>
            <div className="lp-footer__col">
              <h4>{copy.footer.resources}</h4>
              <a href={`${docsHref}#quickstart`}>{copy.footer.quickstart}</a>
              <a href={`${docsHref}#source`}>{copy.footer.architecture}</a>
              <a href={docsHref}>{copy.nav.docs}</a>
            </div>
            <div className="lp-footer__col">
              <h4>{copy.footer.openSource}</h4>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">{copy.footer.license}</a>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">{copy.footer.issues}</a>
            </div>
          </div>
          <div className="lp-footer__base">
            <span>{copy.footer.copyright}</span>
            <span>{copy.footer.built}</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
