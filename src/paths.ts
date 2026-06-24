// Single source of truth for on-disk locations. OPEN_TAG_HOME (default ~/.open-tag) lets each
// worktree/dev environment use its own data dir so parallel daemons/agents never collide.
// Read on each call so env loaded by env.ts (before first use) is honored, and tests can toggle it.
import os from "node:os";
import path from "node:path";

export const openTagHome = (): string => process.env.OPEN_TAG_HOME ?? path.join(os.homedir(), ".open-tag");
export const agentsDir = (): string => path.join(openTagHome(), "agents");
export const binDir = (): string => path.join(openTagHome(), "bin");
export const machineIdFile = (): string => path.join(openTagHome(), "machine-id");
// Legacy specific overrides keep precedence over the HOME-derived default (back-compat).
export const logsDir = (): string => process.env.OPEN_TAG_LOG_DIR ?? path.join(openTagHome(), "logs");
export const uploadsDir = (): string => process.env.OPEN_TAG_UPLOAD_DIR ?? path.join(openTagHome(), "uploads");
