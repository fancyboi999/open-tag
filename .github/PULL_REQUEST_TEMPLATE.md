## Summary

<!-- 1–3 bullets describing what this PR does and why. -->

- 

## Motivation / linked issue

<!-- Closes #N  /  Relates to #N  /  Standalone improvement -->

## Changes

<!-- List the files changed and why each change was made. Keep it surgical —
every changed line should trace back to the task described above. -->

## Test plan and evidence

<!-- Code complete ≠ task done. Paste real output — not "I think it works."

For backend / REST changes:
  - curl command + response (against a running server)

For frontend / UI changes:
  - Before / after screenshots from a real browser session

For daemon / agent-runtime changes:
  - dev:e2e:up output + browser/curl confirmation

For docs-only changes:
  - npm run typecheck (must pass) -->

```
# paste evidence here
```

## Doc-sync checklist

Check every box that applies — leave unchecked boxes with a note explaining
why the corresponding doc was not changed.

- [ ] `src/db/schema.ts` changed → `docs/generated/db-schema.md` updated
- [ ] Routes / endpoints changed → `ARCHITECTURE.md` updated
- [ ] Module boundary / invariant changed → `ARCHITECTURE.md` §II–IV updated
- [ ] Feature completed or modified → `FEATURES.md` checkbox updated
- [ ] Doc/code mismatch found → entry added to `docs/tech-debt-tracker.md`
- [ ] `src/daemon/**` (bundle) changed → `packages/daemon/package.json` version bumped + GitHub Release planned
- [ ] No doc-sync needed (explain why): 

## Verification bar

- [ ] `npm run typecheck` passes
- [ ] Unit/integration tests pass (`npx tsx --test --test-force-exit test/*.unit.test.ts`)
- [ ] Real-run evidence posted above (curl / screenshot / CLI output)
- [ ] Fail-loud: I've listed below what was **not** verified in this PR

**Not verified / skipped:**

<!-- Be explicit. "Nothing skipped" is almost never true. -->
