// Register/login page and invite landing page. Independent of StoreProvider bootstrap — fetches /api/auth/* directly, stores the token on success, and redirects to the main app (re-runs bootstrap with the real token).
import { useEffect, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { TOKEN_KEY } from "../routing.ts"; // single source for the session-token storage key (shared with store.tsx + the "/" guard)

// On successful login/register: persist token, clear dev user, and redirect to target. The caller resolves the
// user's workspace (see workspaceHome); "/" is only a defensive fallback (it renders the marketing Landing, NOT a redirect).
function finishAuth(token: string, to = "/") {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.removeItem("open-tag.devuser"); // clear dev user so dev-login doesn't override the real account
  window.location.assign(to);
}

// Where to land after auth: the user's first workspace, resolved from the SAME source bootstrap uses
// (GET /api/servers → serverList[0]) so the target always matches RootRedirect. Falls back to "/" if none.
async function workspaceHome(token: string): Promise<string> {
  try {
    const servers = await (await fetch("/api/servers", { headers: { authorization: "Bearer " + token } })).json();
    const slug = Array.isArray(servers) ? servers[0]?.slug : null;
    return slug ? `/s/${slug}/channel` : "/";
  } catch { return "/"; }
}

function authErrorMessage(t: TFunction, data: any, fallback: string): string {
  const code = typeof data?.code === "string" ? data.code : "";
  if (code) {
    const translated = t(`auth.errors.${code}`, { defaultValue: "" });
    if (translated) return translated;
  }
  return String(data?.error || fallback);
}

function AuthFields({
  mode,
  name,
  email,
  password,
  err,
  onName,
  onEmail,
  onPassword,
}: {
  mode: "login" | "register";
  name: string;
  email: string;
  password: string;
  err: string;
  onName: (value: string) => void;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
}) {
  const { t } = useTranslation();
  const describedBy = err ? "auth-error" : undefined;
  const onPasswordKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && e.nativeEvent.isComposing) e.preventDefault();
  };
  return (
    <>
      {mode === "register" && (
        <label className="auth-field" htmlFor="auth-name">
          <span>{t("auth.usernameLabel")}</span>
          <input id="auth-name" autoComplete="username" placeholder={t("auth.usernamePlaceholder")} value={name} onChange={(e) => onName(e.target.value)} aria-describedby={describedBy} required />
        </label>
      )}
      <label className="auth-field" htmlFor="auth-email">
        <span>{t("auth.emailLabel")}</span>
        <input id="auth-email" autoComplete="email" placeholder={t("auth.emailPlaceholder")} type="email" value={email} onChange={(e) => onEmail(e.target.value)} aria-describedby={describedBy} required />
      </label>
      <label className="auth-field" htmlFor="auth-password">
        <span>{t("auth.passwordLabel")}</span>
        <input id="auth-password" autoComplete={mode === "register" ? "new-password" : "current-password"} placeholder={t("auth.passwordPlaceholder")} type="password" value={password} onChange={(e) => onPassword(e.target.value)} onKeyDown={onPasswordKeyDown} aria-describedby={describedBy} required />
      </label>
      {err && <div id="auth-error" className="form-err" role="alert" aria-live="polite">{err}</div>}
    </>
  );
}

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const body = mode === "register" ? { name, email, password } : { email, password };
      const r = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok || !d.token) throw new Error(authErrorMessage(t, d, t("auth.opFailed")));
      finishAuth(d.token, await workspaceHome(d.token));
    } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  };
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">open-tag</div>
        <h1>{mode === "register" ? t("auth.createAccount") : t("auth.login")}</h1>
        <form className="auth-form" onSubmit={submit}>
          <AuthFields mode={mode} name={name} email={email} password={password} err={err} onName={setName} onEmail={setEmail} onPassword={setPassword} />
          <button className="ok auth-submit" type="submit" disabled={busy}>{busy ? "…" : mode === "register" ? t("auth.register") : t("auth.login")}</button>
        </form>
        <div className="auth-alt">{mode === "register" ? <>{t("auth.hasAccount")}<a href="/login">{t("auth.login")}</a></> : <>{t("auth.noAccount")}<a href="/register">{t("auth.register")}</a></>}</div>
      </div>
    </div>
  );
}

export function JoinPage() {
  const { t } = useTranslation();
  const { token } = useParams();
  const [info, setInfo] = useState<any>(null);
  const [mode, setMode] = useState<"login" | "register">("register");
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const loggedIn = !!localStorage.getItem(TOKEN_KEY);
  useEffect(() => { (async () => { try { setInfo(await (await fetch(`/api/auth/invite-info?token=${encodeURIComponent(token || "")}`)).json()); } catch { setInfo({ valid: false }); } })(); }, [token]);
  const accept = async (authToken: string) => {
    const r = await fetch("/api/auth/accept-invite", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + authToken }, body: JSON.stringify({ token }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || t("auth.joinFailed"));
    finishAuth(authToken, `/s/${d.serverSlug}/channel`);
  };
  const joinAsCurrent = async () => { if (busy) return; setBusy(true); setErr(""); try { await accept(localStorage.getItem(TOKEN_KEY)!); } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); } };
  const submitAuth = async (e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const body = mode === "register" ? { name, email, password } : { email, password };
      const r = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok || !d.token) throw new Error(authErrorMessage(t, d, t("auth.opFailed")));
      await accept(d.token);
    } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  };
  if (!info) return <div className="auth-page"><div className="auth-card">{t("auth.loading")}</div></div>;
  if (!info.valid) return <div className="auth-page"><div className="auth-card"><div className="auth-brand">open-tag</div><h1>{t("auth.invalidInvite")}</h1><p className="modal-note">{t("auth.invalidInviteDesc")}</p><a href="/">{t("auth.backHome")}</a></div></div>;
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">open-tag</div>
        <h1>{t("auth.joinTitle", { serverName: info.serverName })}</h1>
        <p className="modal-note">{info.inviterName ? t("auth.invitedBy", { inviter: info.inviterName }) : t("auth.youAreInvited")}{t("auth.joinWorkspace", { serverName: info.serverName, role: info.role })}</p>
        {loggedIn ? (
          <button className="ok auth-submit" disabled={busy} onClick={joinAsCurrent}>{t("auth.joinAsCurrent")}</button>
        ) : (<>
          <form className="auth-form" onSubmit={submitAuth}>
            <AuthFields mode={mode} name={name} email={email} password={password} err={err} onName={setName} onEmail={setEmail} onPassword={setPassword} />
            <button className="ok auth-submit" type="submit" disabled={busy}>{busy ? "…" : mode === "register" ? t("auth.registerAndJoin") : t("auth.loginAndJoin")}</button>
          </form>
          <div className="auth-alt">{mode === "register" ? <>{t("auth.hasAccount")}<a onClick={() => { setMode("login"); setErr(""); }}>{t("auth.login")}</a></> : <>{t("auth.newUser")}<a onClick={() => { setMode("register"); setErr(""); }}>{t("auth.register")}</a></>}</div>
        </>)}
      </div>
    </div>
  );
}
