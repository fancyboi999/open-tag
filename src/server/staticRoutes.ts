const APP_SHELL_EXACT_PATHS = new Set(["/", "/features", "/login", "/register"]);

export function shouldServeAppShell(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  if (APP_SHELL_EXACT_PATHS.has(normalized)) return true;
  return pathname.startsWith("/join/") || pathname.startsWith("/s/");
}
