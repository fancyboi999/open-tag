# Self-Hosting open-tag on Windows

> This guide adapts [`docs/self-host.md`](./self-host.md) for Windows. Read that first for the architecture overview and general concepts; this document covers only the Windows-specific differences.

## Prerequisites

| Requirement | Windows Install |
|---|---|
| Docker | **Docker Desktop for Windows** (includes Docker Compose v2). Install from [docker.com](https://docs.docker.com/desktop/setup/install/windows-install/). Enable WSL2 backend during setup. |
| Node.js 20+ | Install from [nodejs.org](https://nodejs.org/) or via `winget install OpenJS.NodeJS.LTS`. Required only for Bare Node.js path. |
| Git | `winget install Git.Git` or from [git-scm.com](https://git-scm.com/). Ensure `git config core.autocrlf input` for shell scripts. |
| Domain + DNS | A domain name pointing to your Windows machine's public IP (for HTTPS). |

## Key Windows differences at a glance

| Linux (self-host.md) | Windows equivalent |
|---|---|
| `openssl rand -hex 32` | PowerShell: `[System.Convert]::ToHexString((New-Object byte[] 32 \| %{0..255 \| Get-Random}))` |
| `~/.open-tag` | `$env:USERPROFILE\.open-tag` |
| systemd service | Windows Task Scheduler or NSSM |
| `sudo ufw allow` | `New-NetFirewallRule` (PowerShell) |
| Caddy / nginx + Certbot | Caddy for Windows (automatic TLS, recommended) |
| `cron` backup | Windows Task Scheduler |

## Step 1 — Clone and handle line endings

```powershell
git clone https://github.com/fancyboi999/open-tag.git
cd open-tag
```

**CRLF hazard**: shell scripts inside the Docker container need LF line endings. The repo ships a `.gitattributes` file that enforces this automatically. After cloning, verify:

```powershell
# Check that shell scripts are LF:
$cr = [System.IO.File]::ReadAllBytes("scripts\docker-entrypoint.sh") | Where-Object {$_ -eq 0x0D}
"CR bytes: $($cr.Count)"   # should be 0
```

If you see CR bytes > 0, convert:

```powershell
$f = "scripts\docker-entrypoint.sh"
$b = [System.IO.File]::ReadAllBytes($f) | Where-Object {$_ -ne 0x0D}
[System.IO.File]::WriteAllBytes($f, $b)
```

> **Why this matters**: Linux containers read the shebang (`#!/bin/sh`) in shell scripts. A CRLF file becomes `#!/bin/sh\r`, the kernel looks for `/bin/sh\r` (nonexistent), and the container crashes with `exec format error` or `no such file or directory`.

### Configure secrets

```powershell
Copy-Item .env.docker.example .env.docker
```

Generate the three required secrets with PowerShell:

```powershell
# Generate 32 random bytes as hex string
$rand = [System.Convert]::ToHexString((New-Object byte[] 32 | %{0..255 | Get-Random}))
$rand   # paste this into .env.docker for JWT_SECRET / DAEMON_BOOTSTRAP_KEY / ADMIN_SETUP_TOKEN
```

Open `.env.docker` in any editor, replace the three secrets, and ensure `ALLOW_DEV_LOGIN=false` is set.

## Step 2 — Start the control plane

Same as the Linux guide — Docker Desktop handles the container runtime:

```powershell
docker compose --profile app up -d --build
```

Verify:

```powershell
docker compose ps
docker compose logs app --tail=50
```

> **Troubleshooting**: If the `app` container exits immediately with `exec /usr/local/bin/docker-entrypoint.sh: no such file or directory`, the shell script still has CRLF line endings. See **CRLF hazard** above.

The server listens on port **7788** (or `${APP_PORT}` if overridden).

## Step 3 — Initialize the admin account

Same as the Linux guide — the endpoint is identical:

```powershell
curl.exe -X POST http://localhost:7788/api/auth/setup `
  -H "content-type: application/json" `
  -d '{"token":"<ADMIN_SETUP_TOKEN>","email":"you@example.com","password":"<min 8 chars>"}'
```

After success, clear `ADMIN_SETUP_TOKEN` from `.env.docker` and restart:

```powershell
docker compose --profile app restart app
```

## Step 4 — Connect the daemon

The daemon runs on the same Windows host.

> **Windows compatibility fixes in local repo**: The published npm daemon (`@fancyboi999/open-tag-daemon`) has two Windows issues: (1) runtime detection uses POSIX `command -v` (no runtimes detected), (2) all runtime CLI spawns use raw `spawn()` which fails on Windows + nvm4w symlink `.cmd` files. Both are fixed in the local repo. Until a new release is published, run the daemon from the local repo instead:
>
> ```powershell
> cd E:\open-tag
> npx tsx src/daemon/index.ts --server-url http://localhost:7788 --api-key <DAEMON_BOOTSTRAP_KEY>
> ```

If you prefer the published package (runtime detection will return no runtimes, and agent spawns will fail on Windows):

```powershell
npx @fancyboi999/open-tag-daemon@latest `
  --server-url http://localhost:7788 `
  --api-key <DAEMON_BOOTSTRAP_KEY>
```

**Long-running the daemon** (instead of keeping a terminal open):

### Option A — NSSM (recommended)

Install [NSSM](https://nssm.cc/) and register the daemon as a Windows service. Run from the local repo for runtime detection:

```powershell
# Install nssm via winget
winget install nssm

# Register the service (local repo path for Windows compatibility fixes)
nssm install open-tag-daemon "C:\Program Files\nodejs\npx.cmd" `
  "tsx E:\open-tag\src\daemon\index.ts --server-url http://localhost:7788 --api-key <key>"

# Set working directory
nssm set open-tag-daemon AppDirectory "E:\open-tag"

# Start
nssm start open-tag-daemon
```

When the published daemon includes the Windows compatibility fixes, switch to:

```powershell
nssm set open-tag-daemon AppParameters " @fancyboi999/open-tag-daemon@latest --server-url http://localhost:7788 --api-key <key>"
```

### Option B — Windows Task Scheduler

Create a task:
- Trigger: **At startup**
- Action: Start a program → `C:\Program Files\nodejs\npx.cmd`
- Arguments: `tsx E:\open-tag\src\daemon\index.ts --server-url http://localhost:7788 --api-key <key>`
- Start in: `E:\open-tag`
- Run whether user is logged on or not

## Step 5 — Firewall and HTTPS

### Firewall

Open ports 80 and 443 (PowerShell as Administrator):

```powershell
New-NetFirewallRule -DisplayName "open-tag HTTP" -Direction Inbound -Protocol TCP -LocalPort 80,443 -Action Allow
```

### HTTPS — Caddy for Windows (recommended)

1. Download Caddy from [caddyserver.com/download](https://caddyserver.com/download) (choose Windows).

2. Create `Caddyfile` in the Caddy directory:

```
your-domain.com {
    reverse_proxy localhost:7788
}
```

3. Run Caddy (or register as a service):

```powershell
# Test (runs in foreground)
caddy run

# Or register as Windows service:
caddy run --service install
```

Caddy automatically provisions Let's Encrypt certificates.

### HTTPS — nginx for Windows (alternative)

Download [nginx for Windows](http://nginx.org/en/download.html) and configure:

```nginx
# conf/nginx.conf
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     C:/certs/fullchain.pem;
    ssl_certificate_key C:/certs/privkey.pem;

    location / {
        proxy_pass         http://localhost:7788;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_read_timeout 3600s;
    }
}
```

Use `certbot` via WSL or a standalone ACME client for certificate issuance.

## Step 6 — Verify

Open `https://your-domain.com` in a browser, log in, and confirm the daemon is online under **Settings → Computers**.

## Backup (Windows Task Scheduler)

### Database backup

Create a PowerShell script (`C:\scripts\open-tag-backup.ps1`):

```powershell
$dest = "C:\backups\open-tag-db-$(Get-Date -Format 'yyyyMMdd-HHmmss').dump"
docker exec open-tag-pg pg_dump -U opentag -d opentag -Fc | Set-Content $dest -Encoding Byte
# Delete backups older than 14 days
Get-ChildItem C:\backups\ -Filter "open-tag-db-*.dump" |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
  Remove-Item
```

Then create a Task Scheduler task:
- Trigger: **Daily at 3:00 AM**
- Action: Start a program → `powershell.exe`
- Arguments: `-File C:\scripts\open-tag-backup.ps1`

### Agent workspace backup

```powershell
$date = Get-Date -Format "yyyyMMdd"
Compress-Archive -Path "$env:USERPROFILE\.open-tag\agents" `
  -DestinationPath "C:\backups\open-tag-agents-$date.zip"
```

## Environment variables

Same as Linux. Override `OPEN_TAG_HOME` with a Windows path:

```
OPEN_TAG_HOME=C:\Users\You\.open-tag
```

In `.env.docker`, the internal URLs stay the same:

```
DATABASE_URL=postgres://opentag:opentag@postgres:5432/opentag
REDIS_URL=redis://redis:6379
PORT=7788
```

These are Docker Compose service names — they resolve inside the container network, not to the Windows host.

## Runtime detection

On Windows, the daemon uses PowerShell's `Get-Command` to detect installed agent CLIs (`claude`, `codex`, `opencode`, etc.). This replaces the Linux/macOS `command -v` which is not available on Windows.

If you have an agent CLI installed but the daemon reports no runtimes, check:

```powershell
# Verify the CLI is on PATH:
powershell -NoProfile -Command "Get-Command opencode -ErrorAction Stop"
```

The daemon also checks for: `claude`, `codex`, `copilot`, `kimi`, `opencode`, `pi`, `cursor-agent`, `hermes`. Only those on PATH are reported as available.

## Known Windows limitations

| Area | Limitation |
|---|---|
| **systemd services** | Not available on Windows. Use NSSM or Task Scheduler instead. For graceful shutdown: NSSM sends Ctrl+C (SIGINT, supported); Task Scheduler should use `taskkill /PID <pid>` or `taskkill /F` (force, kills agent children). The daemon also listens for `SIGBREAK` (Ctrl+Break) on Windows. |
| **openssl CLI** | Not included in Windows by default. Use the PowerShell snippet above, or install OpenSSL via `winget install OpenSSL.Light`. |
| **cron** | Not available. Use Task Scheduler. |
| **nginx + Certbot** | nginx for Windows is available but less tested. Caddy for Windows is the recommended HTTPS solution. |
| **Docker volume mounts** | When mounting host directories into containers, use absolute Windows paths (e.g. `C:\Users\You\.open-tag\uploads`). Docker Desktop translates these automatically. |
| **Agent runtimes** | Agent CLIs (`claude`, `codex`, `opencode`, etc.) must be installed on Windows and available on `PATH`. Some runtimes may have Windows-specific installation steps or limitations. |
| **Agent PATH environment** | The daemon injects `~/.open-tag/bin` into spawned agent processes. On Windows, PATH entries must be separated by `;` (not `:`). The daemon now uses `path.delimiter` for cross-platform compatibility. |

## Troubleshooting

### Container exits with "no such file or directory"

**Cause**: `scripts/docker-entrypoint.sh` has CRLF line endings.

**Fix**: Convert to LF (see Step 1), then rebuild:

```powershell
docker compose --profile app build --no-cache app
docker compose --profile app up -d
```

### Port already in use

Override the port:

```powershell
$env:APP_PORT = "8080"
docker compose --profile app up -d
```

Or check what's using the default port:

```powershell
netstat -ano | Select-String ":7788"
```

### Daemon won't start — "npx not found"

Ensure Node.js is on PATH:

```powershell
npx --version   # should print a version, not an error
```

If using nvm-windows, run the daemon from a terminal where Node.js is activated, or use the full path to `npx.cmd`.
