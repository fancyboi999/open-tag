# Daemon Update Guide Design

## Goal

Online machines running an older daemon version must expose a clear update path from the UI, without pretending the browser can upgrade or kill a process on the user's machine.

## Constraints

- Do not add daemon self-update or remote process-control protocol.
- Do not rotate a machine key while the machine is online.
- Do not expose or reconstruct a stored machine key; only `apiKeyPrefix` is available after first generation.
- Keep the offline Reconnect flow as the only fresh-key generation path.
- Do not touch `src/daemon/**`; this is a web guidance change, not a daemon package release.

## UX

The alert for an outdated online daemon should tell the operator to open Computers for update steps, not just "stop and reconnect." On the Computers detail page, an online machine whose `daemonVersion` differs from `latestDaemonVersion` shows an `Update daemon` action next to Delete.

The update modal is guidance-only. It explains that the browser cannot upgrade the local process and that the stored machine key cannot be recovered. It gives two operator paths:

1. If the original `sk_machine_*` key or command was saved, stop the old daemon process on that machine and rerun the daemon with `@latest` and the existing key.
2. If the key was not saved, stop the old daemon process, wait until this machine becomes offline, then use the existing Reconnect button to generate a fresh `@latest` command.

The modal may show a command template with `<your sk_machine_... key>` as a placeholder, but it must not suggest that the placeholder is executable.

## Files

- `web/src/machineUi.ts`: pure helpers for daemon staleness and command template text.
- `web/src/views/misc.tsx`: Computers page update button and guidance modal.
- `web/src/alerts.tsx`: outdated alert body copy remains state-derived, but points to Computers for update steps.
- `web/src/locales/en.json` and `web/src/locales/zh.json`: user-facing copy.
- `test/machineUpdateGuide.unit.test.ts`: red/green tests for stale detection and command template constraints.
- `FEATURES.md`: update the System alert center entry with the new online outdated guidance.

## Verification

- Failing test first: online outdated machine should be considered update-guided, offline/same-version/no-latest should not.
- Unit tests pass for the helper.
- `npm run typecheck` passes.
- Browser run shows the Computers page action and modal copy for an online stale machine state.
