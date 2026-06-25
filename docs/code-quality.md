# Code quality — full text

> Canonical expansion of AGENTS.md's **Code quality** section. AGENTS.md keeps the
> must-obey core (so it stays a map); the full rationale and per-rule detail live here.
> Read this when a change touches non-trivial logic, the agent prompt, or anything you're
> about to call "done".

## Eight shalls and eight shall-nots

**Shall:** Understand where an interface comes from and why it exists; trace upstream
and downstream dependencies when necessary.
**Shall not:** Guess at interfaces without reading the code or docs.

**Shall:** Clarify goal, boundary conditions, and input/output before writing anything.
**Shall not:** Start coding with a fuzzy understanding, then rely on luck to pass review.

**Shall:** Ask the product owner or backend directly when business logic is unclear.
**Shall not:** Fill in missing information with assumptions and treat them as facts.

**Shall:** Reuse existing interfaces, components, and conventions to keep the system
consistent and maintainable.
**Shall not:** Casually invent a new interface or utility for the sake of it.

**Shall:** Verify code against edge cases, error paths, concurrency, and perf paths.
**Shall not:** Only test the happy path and hope for the best.

**Shall:** Code structure follows the architecture; style follows team conventions —
even when refactoring is expensive.
**Shall not:** Ship "it runs" code that ignores the architecture.

**Shall:** Admit "I don't know" and look it up; make decisions with data.
**Shall not:** Bluff, over-explain, or use confidence to cover ignorance.

**Shall:** Understand the original intent, assess impact, and fully verify before
changing any code.
**Shall not:** Spot a problem and immediately patch it — that turns one bug into three.

**Shall:** Use the minimum code that solves the problem; prefer reuse over invention,
simple over "flexible".
**Shall not:** Write 200 lines of code for a 50-line problem, or add extension points
nobody asked for.

**Shall:** Make surgical changes — every line in the diff must trace back to the
current requirement.
**Shall not:** Opportunistically "clean up" adjacent code or reformat things you
dislike; that turns diffs into archaeology.

**Shall:** When two conflicting patterns exist in the codebase, pick the newer / more
central / more widely depended-on one, state why, and mark the other as pending cleanup.
**Shall not:** Write "satisfies both" code — dual error handlers, calling old and new
APIs simultaneously, mixing two state-management systems. Hybrids are harder to
maintain and harder to debug than either pure form.

## Agent-prompt red line (load-bearing)

`src/daemon/prompt.ts` is the **standing system prompt shared by every runtime**
(claude, codex, and any future runtime). It must stay **runtime-agnostic**:

- Do **not** hard-code tool names specific to one provider (e.g. `Read`, `cat`,
  `grep`, vision-specific instructions).
- Describe capabilities in generic terms.
- After editing, `grep` for provider-specific tool names to confirm zero hits.

## Verification before "done"

Completing code ≠ completing the task. Verification layers (use every applicable one):

1. **Unit tests** — verify logic correctness.
2. **Integration / E2E tests** — verify API endpoints, DB operations, module wiring.
3. **Real-run verification** — `curl` real endpoints; open the browser with the
   chrome-devtools MCP (pass `--isolated` when running in parallel so you get your own
   Chrome instance instead of grabbing a shared one) and confirm rendering and
   interaction; run CLI commands and confirm output. Never just "feel like it should work."
4. Post real evidence (command output, screenshot, test results) before claiming done.

**Fail loudly — no silent failures.** Every "done" claim must explicitly list:
- What was skipped or filtered out.
- Any warnings (compiler, runtime, migration constraints).
- What was not verified — which paths / edge cases were not exercised.

"Migration succeeded / tests passed / feature OK" is not trusted on its own;
it must be accompanied by the above checklist.
