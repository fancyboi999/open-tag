// Reads agent workspace (~/.open-tag/agents/<id>/) and exposes file tree / file content via WS-RPC to the server.
// File tree: returns a flat list of the entire tree {files:[{name,path,isDirectory,size,modifiedAt}]};
//            read file: returns {path, content}. Security: path must remain inside the workspace root (prevents ../ escape).
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { agentsDir } from "../paths.js";

const DATA_DIR = agentsDir();
const MAX_FILE = 256 * 1024;
const SKIP = new Set(["node_modules", ".git"]);

function safe(agentId: string, rel: string): string | null {
  const root = path.join(DATA_DIR, agentId);
  const target = path.resolve(root, rel || ".");
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

interface FileNode { name: string; path: string; isDirectory: boolean; size: number; modifiedAt: string | null }

async function walk(root: string, rel: string, acc: FileNode[], depth: number): Promise<void> {
  if (depth > 6 || acc.length > 2000) return;
  let ds; try { ds = await readdir(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const d of ds) {
    if (SKIP.has(d.name)) continue;
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    let size = 0; let modifiedAt: string | null = null;
    try { const s = await stat(path.join(root, childRel)); size = d.isFile() ? s.size : 0; modifiedAt = s.mtime.toISOString(); } catch { /* */ }
    acc.push({ name: d.name, path: childRel, isDirectory: d.isDirectory(), size, modifiedAt });
    if (d.isDirectory()) await walk(root, childRel, acc, depth + 1);
  }
}

/** Full flat file tree (aligned with the workspace-files protocol). */
export async function listWorkspace(agentId: string, _subPath = "") {
  // _subPath: passed by callers for protocol alignment with readWorkspaceFile; current implementation always returns the full tree.
  const root = path.join(DATA_DIR, agentId);
  try { const files: FileNode[] = []; await walk(root, "", files, 0); return { files }; }
  catch (e: any) { return { error: String(e?.message ?? e) }; }
}

// Extract a frontmatter field: supports inline (description: foo) and YAML block scalars (description: > / | followed by indented lines).
function fmField(fm: string, key: string): string {
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = new RegExp(`^${key}:\\s*(.*)$`, "i").exec(lines[i]!);
    if (!m) continue;
    const inline = m[1]!.trim();
    if (inline && !/^[|>][+-]?$/.test(inline)) return inline.replace(/^["']|["']$/g, ""); // inline value
    const block: string[] = []; // block scalar: collect subsequent indented lines
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s+\S/.test(lines[j]!)) block.push(lines[j]!.trim());
      else if (lines[j]!.trim() === "") block.push("");
      else break;
    }
    return block.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}
// List available skills on the agent machine. global = ~/.claude/skills; workspace = <workspace>/.claude/skills.
async function readSkillsDir(dir: string, sourcePath: string) {
  const out: { name: string; displayName: string; description: string; userInvocable: boolean; sourcePath: string }[] = [];
  let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let name = e.name, description = "", userInvocable = false;
    try {
      const txt = await readFile(path.join(dir, e.name, "SKILL.md"), "utf8");
      const fm = /^---\n([\s\S]*?)\n---/.exec(txt);
      if (fm) {
        name = fmField(fm[1]!, "name") || e.name;
        description = fmField(fm[1]!, "description");
        userInvocable = /^(true|yes)$/i.test(fmField(fm[1]!, "user-invocable") || fmField(fm[1]!, "userInvocable"));
      }
    } catch { continue; } // no SKILL.md → not counted as a skill
    out.push({ name, displayName: name, description, userInvocable, sourcePath });
  }
  return out;
}
export async function listSkills(agentId: string) {
  const global = await readSkillsDir(path.join(os.homedir(), ".claude", "skills"), "~/.claude/skills");
  const workspace = await readSkillsDir(path.join(DATA_DIR, agentId, ".claude", "skills"), "<workspace>/.claude/skills");
  return { global, workspace };
}

export async function readWorkspaceFile(agentId: string, rel: string) {
  const file = safe(agentId, rel);
  if (!file) return { error: "invalid path" };
  try {
    const s = await stat(file);
    if (!s.isFile()) return { error: "not a file" };
    if (s.size > MAX_FILE) return { error: `file too large (${s.size} bytes, max ${MAX_FILE})` };
    const buf = await readFile(file);
    if (buf.includes(0)) return { error: "binary file" };
    return { path: rel, content: buf.toString("utf8") };
  } catch (e: any) { return { error: String(e?.message ?? e) }; }
}
