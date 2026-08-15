// Rich message rendering (react-markdown + remark-gfm + remark-breaks + rehype-sanitize).
// Internal links are encoded as markdown-link [label](tag:type:args) instead of raw <a> injection —
// same effect without dangerouslySetInnerHTML (safer, no XSS).
// Raw HTML in a body is shown as LITERAL TEXT (remarkHtmlAsText), never rendered and never dropped —
// react-markdown's default would silently swallow it, turning an all-HTML message into an empty bubble.
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Info, Lightbulb, MessageSquareWarning, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { copyText } from "./lib/clipboard.ts";

const alertTypes = new Set(["note", "tip", "important", "warning", "caution"]);

// sanitize allows only http/https/mailto by default; also allow our internal tag: protocol (token links)
export const markdownSchema = {
  ...defaultSchema,
  protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? ["http", "https", "mailto"]), "tag"] },
  attributes: {
    ...defaultSchema.attributes,
    blockquote: [
      ...(defaultSchema.attributes?.blockquote ?? []),
      ["className", "github-alert", "github-alert-note", "github-alert-tip", "github-alert-important", "github-alert-warning", "github-alert-caution"],
      ["data-alert", "note", "tip", "important", "warning", "caution"],
    ],
  },
};

const alertConfig: Record<string, { labelKey: string; Icon: LucideIcon }> = {
  note: { labelKey: "md.alertNote", Icon: Info },
  tip: { labelKey: "md.alertTip", Icon: Lightbulb },
  important: { labelKey: "md.alertImportant", Icon: MessageSquareWarning },
  warning: { labelKey: "md.alertWarning", Icon: TriangleAlert },
  caution: { labelKey: "md.alertCaution", Icon: OctagonAlert },
};

export type NameItem = { name?: string; id?: string };
type MentionItem = { type?: string; id?: string; name?: string };
export type Nav = (type: string, args: string[]) => void;
const lc = (x?: string) => (x ?? "").toLowerCase();

function textFromReact(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromReact).join("");
  if (typeof node === "object" && "props" in node) return textFromReact((node as { props?: { children?: ReactNode } }).props?.children);
  return "";
}

function languageFromReact(node: ReactNode): string | null {
  if (node == null || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const lang = languageFromReact(child);
      if (lang) return lang;
    }
    return null;
  }
  if (typeof node === "object" && "props" in node) {
    const props = (node as { props?: { className?: string; children?: ReactNode } }).props;
    const match = props?.className?.match(/(?:^|\s)language-([^\s]+)/);
    if (match?.[1]) return match[1];
    return languageFromReact(props?.children);
  }
  return null;
}

function formatLanguage(lang: string | null): string {
  if (!lang) return "CODE";
  const aliases: Record<string, string> = {
    js: "JS",
    jsx: "JSX",
    ts: "TS",
    tsx: "TSX",
    py: "PYTHON",
    sh: "SHELL",
    bash: "SHELL",
    zsh: "SHELL",
    md: "MARKDOWN",
    html: "HTML",
    css: "CSS",
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
  };
  return aliases[lang.toLowerCase()] ?? lang.replace(/[-_]+/g, " ").toUpperCase();
}

export function CodeBlock({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const text = textFromReact(children).replace(/\n$/, "");
  const lang = formatLanguage(languageFromReact(children));
  const onCopy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } else {
      setCopied(false);
      window.prompt(t("md.copyCode"), text);
    }
  };
  return (
    <div className="md-codeblock">
      <div className="md-codebar">
        <span className="md-code-lang">{lang}</span>
        <button type="button" className="md-code-copy" aria-label={copied ? t("md.copiedCode") : t("md.copyCode")} title={copied ? t("md.copied") : t("md.copyCode")} onClick={onCopy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export function GithubAlertBlockquote({ children, node: _node, ...props }: { children: ReactNode; node?: unknown; [key: string]: unknown }) {
  const { t } = useTranslation();
  const type = String(props["data-alert"] ?? "").toLowerCase();
  const config = alertConfig[type];
  if (!config) return <blockquote {...props}>{children}</blockquote>;
  const Icon = config.Icon;
  return (
    <blockquote {...props}>
      <div className="github-alert-title">
        <Icon size={16} strokeWidth={2.1} aria-hidden="true" />
        <span>{t(config.labelKey)}</span>
      </div>
      {children}
    </blockquote>
  );
}

function isSafeColorValue(value: string): boolean {
  if (!value || value.length > 160 || /[;{}<>]/.test(value)) return false;
  const css = globalThis.CSS;
  return typeof css?.supports === "function" ? css.supports("color", value) : true;
}

export function colorValueFromTag(href?: string | null): string | null {
  if (!href?.startsWith("tag:color:")) return null;
  try {
    const value = decodeURIComponent(href.slice("tag:color:".length));
    return isSafeColorValue(value) ? value : null;
  } catch {
    return null;
  }
}

export function ColorSwatch({ value }: { value: string }) {
  return (
    <span className="color-token" title={value}>
      <span className="color-token-text">{value}</span>
      <span className="color-chip" style={{ backgroundColor: value }} aria-hidden="true" />
    </span>
  );
}

// E9 simplified: code placeholder protection → token→tag: link (whitelist miss = rendered as-is) → restore code.
// @mentions are resolved from the message's own mentions[] — the server-authored message_mentions rows, already
// scoped to channel members — NOT from a workspace-wide name list. So an @name the server did not actually
// deliver (e.g. a non-member in a private channel / DM) renders as plain text, never a fake clickable mention.
// #channel / #thread / task #N still resolve against the workspace channel list.
export function processMessageContent(raw: string, ctx: { mentions: MentionItem[]; channels: NameItem[] }): string {
  if (!raw) return "";
  const codes: string[] = [];
  let s = raw
    .replace(/```[\s\S]*?```/g, (m) => `\u0000C${codes.push(m) - 1}\u0000`)   // fenced code block placeholder (protects inner @# from token pollution)
    .replace(/`[^`\n]+`/g, (m) => `\u0000C${codes.push(m) - 1}\u0000`);          // inline code placeholder
  const refs: string[] = [];
  const ref = (markdownLink: string) => `\u0000R${refs.push(markdownLink) - 1}\u0000`;
  const mMap = new Map(ctx.mentions.map((x) => [lc(x.name), x]));
  const cMap = new Map(ctx.channels.map((c) => [lc(c.name), c]));
  s = s
    .replace(/#([\p{L}\p{N}_-]+):([\da-f]{6,8})/giu, (m, name: string, short: string) => { const c = cMap.get(lc(name)); return c ? ref(`[#${name}:${short}](tag:thread:${c.id}:${short})`) : m; })  // thread reference first (prevent #channel from consuming it)
    .replace(/@([\p{L}\p{N}_-]+)/gu, (m, name: string) => { const mn = mMap.get(lc(name)); return mn ? ref(`[@${name}](tag:${mn.type === "agent" ? "agent" : "human"}:${mn.id})`) : m; })  // only @ the server actually recorded as a mention
    .replace(/(^|[^\w/])(?:task\s+)#([1-9]\d*)\b/giu, (_m, pre: string, num: string) => `${pre}${ref(`[task #${num}](tag:task:${num})`)}`)  // only "task #N" (bare #N not rendered yet: no knownTaskNumbers whitelist, avoids false positives)
    .replace(/#([\p{L}\p{N}_-]+)/gu, (m, name: string) => { const c = cMap.get(lc(name)); return c ? ref(`[#${name}](tag:channel:${c.id})`) : m; });
  return s
    .replace(/\u0000R(\d+)\u0000/g, (_m, i) => refs[+i])
    .replace(/\u0000C(\d+)\u0000/g, (_m, i) => codes[+i]);
}

// remark transform: downgrade every mdast `html` node (block or inline) to a literal `text` node, so raw
// HTML in a message is shown as its source instead of being silently dropped by react-markdown. React still
// escapes text on render, so this stays injection-safe — it never enables HTML rendering, only visibility.
export function remarkHtmlAsText() {
  const downgrade = (node: any): void => {
    if (node.type === "html") node.type = "text";
    if (Array.isArray(node.children)) node.children.forEach(downgrade);
  };
  return (tree: any): void => { downgrade(tree); };
}

function alertParagraphAfterMarker(paragraph: any): { type: string; paragraph: any | null } | null {
  if (paragraph?.type !== "paragraph" || !Array.isArray(paragraph.children) || !paragraph.children.length) return null;
  const [first, ...rest] = paragraph.children;
  if (first?.type !== "text") return null;

  const value = String(first.value ?? "");
  const match = value.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]([\s\S]*)$/i);
  const type = match?.[1]?.toLowerCase();
  if (!type || !alertTypes.has(type)) return null;

  const afterMarker = match?.[2] ?? "";
  if (afterMarker && !/^[ \t]*(?:$|\n|>\s*)/.test(afterMarker)) return null;

  const remainingFirstText = afterMarker.replace(/^[ \t]*(?:\n|>\s*)?/, "");
  const nextChildren = remainingFirstText ? [{ ...first, value: remainingFirstText }, ...rest] : rest;
  const children: any[] = [];
  for (const child of nextChildren) {
    if (child?.type === "break" && children.length === 0) continue;
    if (child?.type === "text") {
      const value = String(child.value ?? "").replace(/^[ \t]+/, "");
      const startsWithCompactBreak = /^>[ \t]+/.test(value);
      if (startsWithCompactBreak && children.length) children.push({ type: "break" });
      const nextValue = value.replace(/^>[ \t]+/, "");
      if (nextValue) children.push({ ...child, value: nextValue });
    } else {
      children.push(child);
    }
  }
  while (children[0]?.type === "break") children.shift();
  while (children.at(-1)?.type === "break") children.pop();

  return {
    type,
    paragraph: children.length ? { ...paragraph, children } : null,
  };
}

export function remarkGithubAlerts() {
  const visit = (node: any): void => {
    if (node.type === "blockquote" && Array.isArray(node.children) && node.children.length) {
      const first = node.children[0];
      const alert = alertParagraphAfterMarker(first);
      if (alert) {
        node.data = {
          ...(node.data ?? {}),
          hProperties: {
            ...(node.data?.hProperties ?? {}),
            className: ["github-alert", `github-alert-${alert.type}`],
            "data-alert": alert.type,
          },
        };
        node.children = alert.paragraph ? [alert.paragraph, ...node.children.slice(1)] : node.children.slice(1);
      }
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  return (tree: any): void => { visit(tree); };
}

const colorFunctionPattern = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/gi;
const hexColorPattern = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![\p{L}\p{N}_-])/giu;

function isWordLike(ch: string): boolean {
  return /[\p{L}\p{N}_-]/u.test(ch);
}

function closingParenIndex(value: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    } else if (ch === "\n") {
      return -1;
    }
  }
  return -1;
}

function colorTokenRanges(value: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of value.matchAll(colorFunctionPattern)) {
    const start = match.index ?? 0;
    if (start > 0 && isWordLike(value[start - 1] ?? "")) continue;
    const open = start + match[0].length - 1;
    const close = closingParenIndex(value, open);
    if (close < 0) continue;
    const token = value.slice(start, close + 1);
    if (!isSafeColorValue(token)) continue;
    ranges.push({ start, end: close + 1 });
  }
  for (const match of value.matchAll(hexColorPattern)) {
    const start = match.index ?? 0;
    if (start > 0 && isWordLike(value[start - 1] ?? "")) continue;
    const end = start + match[0].length;
    if (!isSafeColorValue(match[0])) continue;
    if (ranges.some((r) => start >= r.start && end <= r.end)) continue;
    ranges.push({ start, end });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function colorizeTextNode(node: any): any[] {
  const value = String(node.value ?? "");
  const ranges = colorTokenRanges(value);
  if (!ranges.length) return [node];
  const out: any[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) out.push({ ...node, value: value.slice(cursor, range.start) });
    const token = value.slice(range.start, range.end);
    out.push({ type: "link", url: `tag:color:${encodeURIComponent(token)}`, children: [{ type: "text", value: token }] });
    cursor = range.end;
  }
  if (cursor < value.length) out.push({ ...node, value: value.slice(cursor) });
  return out;
}

export function remarkColorSwatches() {
  const visit = (node: any): void => {
    if (!node || !Array.isArray(node.children)) return;
    if (["link", "linkReference", "image", "imageReference"].includes(node.type)) return;
    const next: any[] = [];
    for (const child of node.children) {
      if (child?.type === "text") next.push(...colorizeTextNode(child));
      else {
        visit(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: any): void => { visit(tree); };
}

export function markdownUrlTransform(url: string): string {
  return url.startsWith("tag:") ? url : defaultUrlTransform(url);
}

export function MessageContent({ content, mentions, channels, nav }: { content: string; mentions: MentionItem[]; channels: NameItem[]; nav: Nav }) {
  const src = useMemo(() => processMessageContent(content, { mentions, channels }), [content, mentions, channels]);
  return (
    <div className="md">
      <ReactMarkdown
        urlTransform={markdownUrlTransform}
        remarkPlugins={[remarkGfm, remarkBreaks, remarkHtmlAsText, remarkGithubAlerts, remarkColorSwatches]}
        rehypePlugins={[[rehypeSanitize, markdownSchema]]}
        components={{
          blockquote({ node: _node, children, ...props }) {
            return <GithubAlertBlockquote {...props}>{children}</GithubAlertBlockquote>;
          },
          pre({ children }) {
            return <CodeBlock>{children}</CodeBlock>;
          },
          a({ href, children }) {
            if (typeof href === "string" && href.startsWith("tag:")) {
              const color = colorValueFromTag(href);
              if (color) return <ColorSwatch value={color} />;
              const [, type, ...args] = href.split(":");
              const cls = type === "agent" ? "mention ref-at ref-agent" : type === "human" ? "mention ref-at ref-human" : type === "channel" ? "ref-chan" : type === "thread" ? "ref-thread" : "ref-task";
              return <a className={cls} onClick={(e) => { e.preventDefault(); nav(type, args); }}>{children}</a>;
            }
            return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
        }}
      >{src}</ReactMarkdown>
    </div>
  );
}
