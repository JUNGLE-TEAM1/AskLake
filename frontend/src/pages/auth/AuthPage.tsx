import { useEffect, useState } from "react";
import { Link } from "react-router";

import { login, signup } from "../../services/authApi";
import { ApiError } from "../../types";
import type { CurrentUserResponse } from "../../types";
import type { AuthMode } from "./authRoute";

type AuthPageProps = {
  initialMode: AuthMode;
  onAuthenticated: (user: CurrentUserResponse) => void;
  onAction: (action: string, apiPath: string, targetId: string, result?: "success" | "failed", options?: { targetType?: "ui" }) => void;
  onModeChange: (mode: AuthMode) => void;
  publicSignupEnabled: boolean;
};

export function AuthPage({ initialMode, onAction, onAuthenticated, onModeChange, publicSignupEnabled }: AuthPageProps) {
  const demoDefaultsEnabled = import.meta.env.DEV || import.meta.env.VITE_AUTH_LEGACY_DEMO_USERS_ENABLED === "true";
  const availableInitialMode = initialMode === "signup" && publicSignupEnabled ? "signup" : "login";
  const [mode, setMode] = useState<AuthMode>(availableInitialMode);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState(demoDefaultsEnabled ? "admin.user@asklake.local" : "");
  const [password, setPassword] = useState(demoDefaultsEnabled ? "asklake-admin" : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMode(initialMode === "signup" && publicSignupEnabled ? "signup" : "login");
    setError(null);
  }, [initialMode, publicSignupEnabled]);

  const changeMode = (nextMode: AuthMode) => {
    if (nextMode === "signup" && !publicSignupEnabled) return;
    setMode(nextMode);
    setError(null);
    onModeChange(nextMode);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = mode === "login"
        ? await login({ email, password })
        : await signup({ displayName, email, password });
      onAuthenticated(response.user);
      onAction(`auth.${mode}.succeeded`, `/api/auth/${mode}`, response.user.id, "success", { targetType: "ui" });
    } catch (unknownError) {
      const message = unknownError instanceof ApiError ? unknownError.message : "인증 요청을 처리하지 못했습니다.";
      setError(message);
      onAction(`auth.${mode}.failed`, `/api/auth/${mode}`, email, "failed", { targetType: "ui" });
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="login-page">
      <Link className="login-brand" to="/" aria-label="AskLake 랜딩으로 돌아가기">
        <img alt="" aria-hidden="true" src="/asklake-wave-icon.png" />
        <strong>AskLake</strong>
      </Link>
      <p className="login-tagline">The Complete Data Pipeline Platform</p>

      <form className="login-card" data-auth-mode={mode} data-testid="auth-login-form" onSubmit={submit}>
        <h1>{mode === "login" ? "Sign In" : "Create Account"}</h1>
        <p className="login-card-description">
          {mode === "login"
            ? "AskLake 계정으로 로그인해 데이터 작업 공간을 시작하세요."
            : "이름과 계정 정보를 입력해 새 AskLake 계정을 만드세요."}
        </p>

        <div className="login-mode-switch" role="tablist" aria-label="계정 모드">
          <button aria-selected={mode === "login"} className={mode === "login" ? "active" : ""} role="tab" type="button" onClick={() => changeMode("login")}>로그인</button>
          {publicSignupEnabled && (
            <button aria-selected={mode === "signup"} className={mode === "signup" ? "active" : ""} data-testid="auth-signup-tab" role="tab" type="button" onClick={() => changeMode("signup")}>회원가입</button>
          )}
        </div>

        {mode === "signup" && (
          <label>
            <span>Display Name</span>
            <input autoComplete="name" name="displayName" onChange={(event) => setDisplayName(event.target.value)} placeholder="Kim Analyst" required value={displayName} />
          </label>
        )}
        <label>
          <span>Email</span>
          <input autoComplete="email" inputMode="email" name="email" onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required type="email" value={email} />
        </label>
        <label>
          <span>Password</span>
          <input autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "signup" ? 8 : 1} name="password" onChange={(event) => setPassword(event.target.value)} placeholder="••••••••" required type="password" value={password} />
        </label>

        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="login-submit" disabled={pending} type="submit">
          {pending ? "Processing..." : mode === "login" ? "Sign In" : "Create Account"}
        </button>

        <div className="login-account-help">
          {mode === "login" ? (
            demoDefaultsEnabled
              ? <small>Admin · admin.user@asklake.local / asklake-admin</small>
              : <small>AskLake 관리자가 발급한 계정으로 로그인하세요.</small>
          ) : (
            <small>비밀번호는 8자 이상 입력하세요. 가입이 완료되면 바로 로그인됩니다.</small>
          )}
        </div>
      </form>
    </main>
  );
}
