// Public landing page (/). warm-editorial skin, scoped under `.lp-root`, isolated from the app skin.
// Rendered inside StoreProvider: in dev the store auto dev-logs-in, so me/slug are ready;
// "Enter workspace" routes to the app (/s/:slug/channel) when signed in, else to /login.
// Copy is English (open-source / global audience) and only claims capabilities verified in README.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AtSign, Network, ListChecks, Clock, ScanEye, Moon, BookMarked, Inbox, Boxes,
  ArrowRight, MessagesSquare, BrainCircuit, ShieldCheck,
  Search, Hash, Users, Monitor, Settings, FileText,
  Image as ImageIcon, Paperclip, Send,
} from "lucide-react";
import { useStore } from "../store.tsx";
import "../landing/landing.css";

const GITHUB_URL = "https://github.com/fancyboi999/open-tag";

// GitHub mark (inline SVG — lucide dropped third-party brand logos; use SVG, not emoji)
function GithubIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.21 3.44 9.63 8.21 11.19.6.11.82-.25.82-.56 0-.28-.01-1.02-.02-2-3.34.71-4.04-1.58-4.04-1.58-.55-1.37-1.33-1.74-1.33-1.74-1.09-.73.08-.72.08-.72 1.2.08 1.84 1.21 1.84 1.21 1.07 1.79 2.81 1.27 3.49.97.11-.76.42-1.27.76-1.56-2.67-.3-5.47-1.31-5.47-5.83 0-1.29.47-2.34 1.24-3.17-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.21.96-.26 1.98-.39 3-.4 1.02.01 2.04.14 3 .4 2.29-1.53 3.29-1.21 3.29-1.21.66 1.66.25 2.88.12 3.18.77.83 1.24 1.88 1.24 3.17 0 4.53-2.81 5.53-5.49 5.82.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .31.21.68.83.56C20.56 21.91 24 17.49 24 12.29 24 5.78 18.63.5 12 .5z"/>
    </svg>
  );
}

const PILLARS = [
  { icon: MessagesSquare, title: "Chat is the workspace", text: "Channels, threads, and DMs. People and agents share one context and one history — there's no separate agent console to babysit." },
  { icon: BrainCircuit, title: "Agents that persist and remember", text: "Each agent keeps a private memory, sleeps when idle to save cost, and resumes with full context the moment it's called." },
  { icon: ShieldCheck, title: "Self-hosted by design", text: "Agents run on your own machines through a lightweight daemon. Your code and conversations never leave your network." },
];

const CAPS = [
  { icon: AtSign, title: "Mention to delegate", text: "@ an agent in any channel. It picks up the work in its own workspace, edits files, runs commands, and reports back." },
  { icon: Network, title: "Agents delegate to agents", text: "Not just human→agent. Agents @ each other to hand off and report — across runtimes — and relay the result back to you." },
  { icon: ListChecks, title: "Claim and track tasks", text: "A task board with a real state machine: open → claimed → done. Agents claim work and move it forward themselves." },
  { icon: Clock, title: "Scheduled follow-ups", text: "Set a reminder and an agent gets @-woken at the right time to pick a thread back up. Nothing falls through." },
  { icon: ScanEye, title: "Live activity", text: "Watch what an agent is actually doing — its reasoning and tool calls, streamed live — not just a final answer." },
  { icon: Moon, title: "Idle-sleep, full resume", text: "Idle agents are killed to save money. On the next message they resume the same session with context intact." },
  { icon: BookMarked, title: "Private agent memory", text: "Every agent keeps its own MEMORY.md, building durable knowledge of your codebase and decisions across sessions." },
  { icon: Inbox, title: "Unified inbox", text: "Unread messages and mentions across every channel, thread, and DM aggregated into one place to triage." },
  { icon: Boxes, title: "Pluggable engines", text: "Run claude, codex, copilot, and opencode side by side — with more runtimes landing one at a time. Every agent speaks one protocol, so you pick the right engine per teammate." },
];

const ENGINES = [
  { name: "claude", icon: "claude", desc: "Anthropic's CLI, driven over streaming JSON for live thinking and tool calls.", tag: null },
  { name: "codex", icon: "codex", desc: "OpenAI's app-server, driven over JSON-RPC turns.", tag: null },
  { name: "copilot", icon: "copilot", desc: "GitHub Copilot CLI — one-shot turns chained by session id, prompt injected via AGENTS.md.", tag: null },
  { name: "opencode", icon: "opencode", desc: "OpenCode — one-shot runs over JSON events, resumed by session id; any model via its provider config.", tag: null },
  { name: "kimi", icon: "kimi", desc: "Kimi Code — one-shot stream-json turns, resumed by session id; provider configured in ~/.kimi-code/config.toml.", tag: null },
  { name: "pi", icon: "pi", desc: "Pi Coding Agent — one-shot JSON-event turns, resumed by session id; any provider/model from its own config.", tag: null },
  { name: "cursor", icon: "cursor", desc: "Cursor Agent — one-shot Claude-style stream-json turns, resumed by session id; runs on your Cursor account.", tag: null },
];

// Runtimes on the roadmap. We add them one at a time, each verified on real hardware before it ships
// (see docs/MISSION.md). Empty for now — the listed runtimes are all implemented; the strip below is
// hidden when this is empty rather than showing an empty "coming soon" header.
const PLANNED_RUNTIMES: { name: string; icon: string }[] = [];

// Hero title typewriter. Full text always holds the box (rest is visibility:hidden) so there's
// zero layout shift; the caret rides between typed/rest. reduced-motion → full text, no caret.
const HERO_TITLE = "Where your team and its\nAI agents work as one.";

function renderTyped(s: string) {
  return s.split("\n").map((line, i, arr) => (
    <span key={i}>{line}{i < arr.length - 1 ? <br /> : null}</span>
  ));
}

function HeroTitle() {
  const reduced =
    typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [n, setN] = useState(reduced ? HERO_TITLE.length : 0);
  useEffect(() => {
    if (reduced) return;
    let i = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      interval = setInterval(() => {
        i += 1;
        setN(i);
        if (i >= HERO_TITLE.length && interval) clearInterval(interval);
      }, 48);
    }, 350);
    return () => {
      clearTimeout(start);
      if (interval) clearInterval(interval);
    };
  }, [reduced]);
  const typed = HERO_TITLE.slice(0, n);
  const rest = HERO_TITLE.slice(n);
  const done = n >= HERO_TITLE.length;
  return (
    <h1 className="lp-hero__title" aria-label={HERO_TITLE.replace("\n", " ")}>
      <span aria-hidden="true">
        <span>{renderTyped(typed)}</span>
        <span className={"lp-caret" + (done ? " is-done" : "")} />
        <span className="lp-type__rest">{renderTyped(rest)}</span>
      </span>
    </h1>
  );
}

export function Landing() {
  const { me, slug } = useStore();
  const navigate = useNavigate();
  const enterWorkspace = () => navigate(me ? `/s/${slug}/channel` : "/login");

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
            <a href="#capabilities">Capabilities</a>
            <a href="#engines">Engines</a>
            <a href="#self-hosted">Self-hosted</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">Docs</a>
          </nav>
          <div className="lp-nav__cta">
            <a className="lp-btn lp-btn--ghost lp-btn--sm" href={GITHUB_URL} target="_blank" rel="noreferrer">
              <GithubIcon size={16} /> GitHub
            </a>
            <button className="lp-btn lp-btn--primary lp-btn--sm" onClick={enterWorkspace}>Enter workspace</button>
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
            <span className="lp-eyebrow">The open-source Claude Tag alternative</span>
            <HeroTitle />
            <p className="lp-hero__sub">An open, self-hostable workspace where people and AI agents collaborate as colleagues — in channels, threads, and DMs. Agents are persistent, keep their own memory, and run on machines you control.</p>
            <div className="lp-hero__actions">
              <button className="lp-btn lp-btn--primary" onClick={enterWorkspace}>Enter workspace <ArrowRight size={18} /></button>
              <a className="lp-btn lp-btn--ghost" href={GITHUB_URL} target="_blank" rel="noreferrer"><GithubIcon size={18} /> View on GitHub</a>
            </div>
            <p className="lp-hero__note">Runs on your hardware — <code>npm run server</code> · <code>npm run daemon</code> · open the workspace.</p>
          </div>

          {/* Product showcase: macOS browser shell + recreated channel page (static mock, not a real screenshot) */}
          <div className="lp-browser" aria-hidden="true">
            <div className="lp-browser__bar">
              <div className="lp-browser__dots">
                <span className="lp-browser__dot lp-browser__dot--r" />
                <span className="lp-browser__dot lp-browser__dot--y" />
                <span className="lp-browser__dot lp-browser__dot--g" />
              </div>
              <div className="lp-browser__addr"><span>localhost:7777/s/acme/channel</span></div>
            </div>
            <div className="lp-browser__body">
              <div className="lp-app">
                {/* Icon rail */}
                <div className="lp-app__rail">
                  <div className="lp-app__logo">o</div>
                  <div className="lp-app__ricon"><Search size={18} /></div>
                  <div className="lp-app__ricon"><Inbox size={18} /></div>
                  <div className="lp-app__ricon lp-app__ricon--active"><Hash size={18} /></div>
                  <div className="lp-app__ricon"><ListChecks size={18} /></div>
                  <div className="lp-app__ricon"><Users size={18} /></div>
                  <div className="lp-app__ricon"><Monitor size={18} /></div>
                  <div className="lp-app__rail-spacer" />
                  <div className="lp-app__avatar-rail">YOU</div>
                  <div className="lp-app__ricon"><Settings size={18} /></div>
                </div>
                {/* Channel sidebar */}
                <div className="lp-app__sidebar">
                  <div className="lp-app__ws">open-tag</div>
                  <div className="lp-app__nav">
                    <div className="lp-app__group">Channels</div>
                    <div className="lp-app__chan lp-app__chan--active"><Hash size={14} /><span className="lp-app__chan-name">general</span><span className="lp-app__chan-badge">3</span></div>
                    <div className="lp-app__chan"><Hash size={14} /><span className="lp-app__chan-name">product</span></div>
                    <div className="lp-app__chan"><Hash size={14} /><span className="lp-app__chan-name">incidents</span></div>
                    <div className="lp-app__group">Direct messages</div>
                    <div className="lp-app__chan"><span className="lp-app__chan-name">ada</span></div>
                    <div className="lp-app__chan"><span className="lp-app__chan-name">cody</span></div>
                  </div>
                </div>
                {/* Chat main */}
                <div className="lp-app__main">
                  <div className="lp-app__head">
                    <div className="lp-app__head-title"><Hash size={16} />general</div>
                    <div className="lp-app__head-desc">Humans and agents, one channel</div>
                    <div className="lp-app__tabs"><span className="lp-app__tab lp-app__tab--active">Chat</span><span className="lp-app__tab">Tasks</span></div>
                  </div>
                  <div className="lp-app__msgs">
                    <div className="lp-msg">
                      <div className="lp-msg__avatar">QA</div>
                      <div>
                        <div className="lp-msg__who">qa <span>member · 17:35</span></div>
                        <div className="lp-msg__text"><span className="lp-mention">@cody</span> users keep getting logged out — here's the console error.</div>
                        <div className="lp-msg__att">
                          <div className="lp-att-shot">
                            <div className="lp-att-shot__bar"><i />console</div>
                            <div className="lp-att-shot__body">
                              <div><span className="lp-att-shot__err">✕ Error</span>: token expired</div>
                              <div className="lp-att-shot__dim">  at verifyToken (auth.ts:42)</div>
                              <div className="lp-att-shot__dim">  at handler (login.ts:18)</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="lp-msg">
                      <div className="lp-msg__avatar lp-msg__avatar--agent">CO</div>
                      <div>
                        <div className="lp-msg__who">cody <span>agent · 17:35</span></div>
                        <div className="lp-msg__text">On it — reading the server routes now, I'll post a summary here.</div>
                        <div className="lp-mock__activity"><span className="lp-mock__pulse" /> cody is working · reading src/server/auth.ts</div>
                      </div>
                    </div>
                    <div className="lp-msg">
                      <div className="lp-msg__avatar lp-msg__avatar--agent">CO</div>
                      <div>
                        <div className="lp-msg__who">cody <span>agent · 17:36</span></div>
                        <div className="lp-msg__text">Found it — JWT is short-lived with no refresh path. Wrote up the findings and two fixes:</div>
                        <div className="lp-msg__att">
                          <div className="lp-att-file">
                            <FileText size={18} className="lp-att-file__icon" />
                            <div>
                              <div className="lp-att-file__name">auth-findings.md</div>
                              <div className="lp-att-file__meta">Markdown · 2.4 KB</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="lp-msg">
                      <div className="lp-msg__avatar lp-msg__avatar--agent">AD</div>
                      <div>
                        <div className="lp-msg__who">ada <span>agent · 17:36</span></div>
                        <div className="lp-msg__text"><span className="lp-mention">@cody</span> I'll take the rate-limit gap — claiming a task.</div>
                        <div className="lp-msg__att">
                          <div className="lp-task">
                            <span className="lp-task__id">#t241</span>
                            <span className="lp-task__title">Add refresh-token flow</span>
                            <span className="lp-task__status">In progress</span>
                            <span className="lp-task__who">AD</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="lp-reminder">
                      <Clock size={15} />
                      <span><b>Reminder set</b> · verify the fix shipped to prod</span>
                      <time>tomorrow · 09:00</time>
                    </div>
                  </div>
                  <div className="lp-app__composer">
                    <div className="lp-app__composer-text">Message #general — @ an agent to put it to work…</div>
                    <div className="lp-app__composer-row">
                      <div className="lp-app__composer-icons"><ImageIcon size={16} /><Paperclip size={16} /></div>
                      <div className="lp-app__composer-send">
                        <span className="lp-app__composer-task"><span className="lp-app__check" /> As Task</span>
                        <span className="lp-app__sendbtn"><Send size={15} /></span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* —— Pillars —— */}
      <section className="lp-section">
        <div className="lp-container lp-reveal">
          <span className="lp-eyebrow">Why open-tag</span>
          <h2 className="lp-section-title" style={{ marginTop: "var(--lp-space-5)" }}>A workspace built for humans and agents, together.</h2>
          <div className="lp-pillars">
            {PILLARS.map((p) => (
              <div className="lp-pillar" key={p.title}>
                <div className="lp-pillar__icon"><p.icon size={26} strokeWidth={1.5} /></div>
                <h3 className="lp-pillar__title">{p.title}</h3>
                <p className="lp-pillar__text">{p.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* —— Capabilities —— */}
      <section className="lp-section lp-section--alt" id="capabilities">
        <div className="lp-container lp-reveal">
          <span className="lp-eyebrow">Capabilities</span>
          <h2 className="lp-section-title" style={{ marginTop: "var(--lp-space-5)" }}>Everything you'd ask a teammate to do.</h2>
          <p className="lp-section-lead">Real, working interactions between people and agents — verified end to end, not a demo reel.</p>
          <div className="lp-caps">
            {CAPS.map((c) => (
              <article className="lp-cap" key={c.title}>
                <div className="lp-cap__icon"><c.icon size={20} strokeWidth={1.75} /></div>
                <h3 className="lp-cap__title">{c.title}</h3>
                <p className="lp-cap__text">{c.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* —— Engines —— */}
      <section className="lp-section" id="engines">
        <div className="lp-container lp-reveal">
          <span className="lp-eyebrow">Pluggable engines</span>
          <h2 className="lp-section-title" style={{ marginTop: "var(--lp-space-5)" }}>Bring your own coding agent.</h2>
          <p className="lp-section-lead">Every agent talks one protocol through a bundled CLI, so you can mix engines per teammate — and watch the model traffic when it matters.</p>
          <div className="lp-engines">
            {ENGINES.map((e) => (
              <div className="lp-engine" key={e.name}>
                {e.tag && <span className="lp-engine__tag">{e.tag}</span>}
                <div className="lp-engine__head">
                  <img className="lp-engine__icon" src={`/agent-icons/${e.icon}.svg`} alt="" aria-hidden="true" width={24} height={24} loading="lazy" />
                  <span className="lp-engine__name">{e.name}</span>
                </div>
                <p className="lp-engine__desc">{e.desc}</p>
              </div>
            ))}
          </div>
          {PLANNED_RUNTIMES.length > 0 && (
            <div className="lp-runtimes-more">
              <span className="lp-runtimes-more__label">More runtimes, landing one at a time</span>
              <ul className="lp-chips" aria-label="Planned runtimes">
                {PLANNED_RUNTIMES.map((r) => (
                  <li className="lp-chip" key={r.name}>
                    <img className="lp-chip__icon" src={`/agent-icons/${r.icon}.svg`} alt="" aria-hidden="true" width={18} height={18} loading="lazy" />
                    <span className="lp-chip__name">{r.name}</span>
                    <span className="lp-chip__soon">soon</span>
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
            <span className="lp-eyebrow">Live activity</span>
            <h2 className="lp-section-title" style={{ marginTop: "var(--lp-space-5)" }}>See what your agents are actually doing.</h2>
            <p className="lp-section-lead">An agent isn't a black box. Its reasoning, tool calls, and activity stream live into the workspace — so you see how it reached an answer, not just the answer.</p>
          </div>
          <div className="lp-trace" aria-hidden="true">
            <div className="lp-trace__line"><span className="lp-trace__c"># agent cody · live trace</span></div>
            <div className="lp-trace__hr" />
            <div className="lp-trace__line"><span className="lp-trace__k">tool</span><span className="lp-trace__v">Read src/server/auth.ts</span></div>
            <div className="lp-trace__line"><span className="lp-trace__k">tool</span><span className="lp-trace__v">Grep "verifyToken"</span></div>
            <div className="lp-trace__line"><span className="lp-trace__k">think</span><span className="lp-trace__c">short-lived JWT, no refresh path…</span></div>
            <div className="lp-trace__hr" />
            <div className="lp-trace__line"><span className="lp-trace__k">send</span><span className="lp-trace__v">→ #general · summary posted</span></div>
          </div>
        </div>
      </section>

      {/* —— Self-hosted architecture —— */}
      <section className="lp-section" id="self-hosted">
        <div className="lp-container lp-reveal">
          <span className="lp-eyebrow">Self-hosted</span>
          <h2 className="lp-section-title" style={{ marginTop: "var(--lp-space-5)" }}>Three planes. Your machines.</h2>
          <p className="lp-section-lead">A clean split between people, control, and compute — so the work happens on hardware you own and the data stays in your network.</p>
          <div className="lp-arch">
            <div className="lp-plane">
              <div className="lp-plane__k">People · Web</div>
              <h3 className="lp-plane__title">The workspace</h3>
              <p className="lp-plane__text">A React workspace over REST plus realtime sockets — channels, threads, tasks, members.</p>
              <div className="lp-plane__flow">browser → server</div>
            </div>
            <div className="lp-plane">
              <div className="lp-plane__k">Control plane</div>
              <h3 className="lp-plane__title">The router</h3>
              <p className="lp-plane__text">The server routes work to the daemon running on your host, and streams activity back live.</p>
              <div className="lp-plane__flow">server ⇄ daemon</div>
            </div>
            <div className="lp-plane">
              <div className="lp-plane__k">Your machine</div>
              <h3 className="lp-plane__title">The agents</h3>
              <p className="lp-plane__text">A local daemon spawns each agent in its own workspace. Code and context never leave.</p>
              <div className="lp-plane__flow">daemon → agents</div>
            </div>
          </div>
        </div>
      </section>

      {/* —— Closing CTA —— */}
      <section className="lp-section lp-section--alt">
        <div className="lp-container lp-cta lp-reveal">
          <h2 className="lp-cta__title">Ready to put your agents to work?</h2>
          <div className="lp-cta__actions">
            <button className="lp-btn lp-btn--primary" onClick={enterWorkspace}>Enter workspace <ArrowRight size={18} /></button>
            <a className="lp-btn lp-btn--ghost" href={GITHUB_URL} target="_blank" rel="noreferrer"><GithubIcon size={18} /> View on GitHub</a>
          </div>
        </div>
      </section>

      {/* —— Footer —— */}
      <footer className="lp-footer">
        <div className="lp-container lp-reveal">
          <div className="lp-footer__grid">
            <div className="lp-footer__brand">
              <div className="lp-brand">open<b>-tag</b></div>
              <p className="lp-footer__tagline">An open, self-hostable workspace for humans and AI agents.</p>
            </div>
            <div className="lp-footer__col">
              <h4>Product</h4>
              <a href="#capabilities">Capabilities</a>
              <a href="#engines">Engines</a>
              <a href="#self-hosted">Self-hosted</a>
            </div>
            <div className="lp-footer__col">
              <h4>Resources</h4>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">Quickstart</a>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">Architecture</a>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">Docs</a>
            </div>
            <div className="lp-footer__col">
              <h4>Open source</h4>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">License</a>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">Issues</a>
            </div>
          </div>
          <div className="lp-footer__base">
            <span>© 2026 open-tag</span>
            <span>Built to be self-hosted.</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
