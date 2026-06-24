// Pure helpers for the agent workspace MEMORY.md.
// Kept side-effect free so the section-surgery logic is unit-testable without touching disk.

/** The initial MEMORY.md seeded on an agent's first start. Title = displayName, `## Role` = description. */
export function seedMemory(displayName: string, description?: string | null): string {
  return `# ${displayName}\n\n## Role\n${roleBody(description)}\n\n## Key Knowledge\n- None yet\n\n## Active Context\n- First startup\n`;
}

/** Normalize a profile description into the body written under `## Role` (mirrors the seed's `|| "Undefined"`). */
function roleBody(description?: string | null): string {
  return (description ?? "").trim() || "Undefined";
}

/**
 * Surgically sync an existing MEMORY.md to a changed profile (admin-wins): rewrite the first H1
 * title to `displayName` and replace the `## Role` section body with `description`, while preserving
 * every other section (## Key Knowledge / ## Active Context / anything the agent wrote).
 * Returns the original string unchanged when nothing needs to change.
 */
export function applyProfileToMemory(content: string, displayName: string, description?: string | null): string {
  const role = roleBody(description);
  const lines = content.split("\n");

  // 1) Title: replace the first H1 (`# ...`) with the current display name.
  const h1 = lines.findIndex((l) => /^#\s+/.test(l));
  if (h1 === -1) {
    // Malformed (no H1) — prepend a fresh header, keep the rest of the doc as-is.
    return `# ${displayName}\n\n## Role\n${role}\n\n${content}`;
  }
  lines[h1] = `# ${displayName}`;

  // 2) Role: replace the `## Role` section body, from the heading up to the next `## ` heading (or EOF).
  const roleIdx = lines.findIndex((l, i) => i > h1 && /^##\s+Role\s*$/i.test(l));
  if (roleIdx === -1) {
    // Agent removed/renamed the Role heading — reinstate it right under the title.
    const head = lines.slice(0, h1 + 1);                  // up to & including the (rewritten) H1
    const restStart = lines[h1 + 1] === "" ? h1 + 2 : h1 + 1; // drop one existing blank to avoid doubling
    return [...head, "", "## Role", role, "", ...lines.slice(restStart)].join("\n");
  }
  let next = lines.length;
  for (let i = roleIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) { next = i; break; }
  }
  const head = lines.slice(0, roleIdx + 1);          // up to and including `## Role`
  const tail = lines.slice(next);                     // the next `## ` section onward (or nothing)
  const body = tail.length ? [role, ""] : [role];     // keep one blank line before a following section
  return [...head, ...body, ...tail].join("\n");
}
