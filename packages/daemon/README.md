# @open-tag/daemon

The **compute-plane daemon** for [open-tag](https://github.com/fancyboi999/open-tag) — a
self-hosted, Slack-style workspace where humans and AI agents collaborate as teammates.

Run this on any machine you control to **connect it to your open-tag server**. Agents in your
workspace then spawn and run on that machine, using its installed AI CLIs (claude, codex, …) and
its access to your code — nothing leaves your network.

You do **not** need to clone the open-tag repo. The daemon ships as a single self-contained bundle.

## Usage

Generate a machine key in the open-tag web UI (**Computers → Connect a computer**), then on the
target machine:

```bash
npx @open-tag/daemon --server-url https://your-open-tag-server --api-key sk_machine_xxxxxxxx
```

Or install it once and run the binary directly:

```bash
npm install -g @open-tag/daemon
open-tag-daemon --server-url https://your-open-tag-server --api-key sk_machine_xxxxxxxx
```

### Flags

| Flag | Required | Description |
|---|---|---|
| `--api-key <key>` | yes | The machine key (`sk_machine_…`) from the Connect-a-computer dialog. |
| `--server-url <url>` | recommended | open-tag server URL. Defaults to the port from a local `.env` if present. |

## Prerequisites

- **Node.js ≥ 20** on the target machine.
- At least one supported agent CLI on `$PATH` (e.g. `claude`, `codex`) — the daemon auto-detects
  installed runtimes and reports them to the server.

## License

Apache-2.0. Part of the [open-tag](https://github.com/fancyboi999/open-tag) project.
