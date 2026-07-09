import { LogIn, UserPlus } from "lucide-react";
import { useState } from "react";
import { InfoBox, PageTitle } from "../../components/common";
import { login, signup } from "../../services/authApi";
import { ApiError } from "../../types";
import type { CurrentUserResponse } from "../../types";

type AuthMode = "login" | "signup";

type AuthPageProps = {
  onAuthenticated: (user: CurrentUserResponse) => void;
  onAction: (action: string, apiPath: string, targetId: string, result?: "success" | "failed", options?: { targetType?: "ui" }) => void;
};

export function AuthPage({ onAction, onAuthenticated }: AuthPageProps) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("admin.user@asklake.local");
  const [password, setPassword] = useState("asklake-admin");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div className="content-grid module-page-grid auth-page">
      <div className="content-main">
        <PageTitle
          title={mode === "login" ? "로그인" : "회원가입"}
          description="로컬 데모 계정으로 로그인하고 세션 기준 권한을 확인합니다."
          icon={mode === "login" ? <LogIn size={28} /> : <UserPlus size={28} />}
        />

        <section className="panel auth-panel">
          <div className="admin-console-tabs auth-tabs" role="tablist" aria-label="계정">
            <button className={mode === "login" ? "active" : ""} type="button" onClick={() => setMode("login")}>
              <LogIn size={16} />
              <span>로그인</span>
            </button>
            <button className={mode === "signup" ? "active" : ""} type="button" onClick={() => setMode("signup")}>
              <UserPlus size={16} />
              <span>회원가입</span>
            </button>
          </div>

          <form className="auth-form" onSubmit={submit}>
            {mode === "signup" && (
              <label className="field">
                <span>이름</span>
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="예: Kim Analyst" required />
              </label>
            )}
            <label className="field">
              <span>이메일</span>
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </label>
            <label className="field">
              <span>비밀번호</span>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={mode === "signup" ? 8 : 1} />
            </label>
            {error && <InfoBox title="인증 실패" body={error} />}
            <div className="form-actions inline">
              <button className="primary-button" type="submit" disabled={pending}>
                {pending ? "처리 중..." : mode === "login" ? "로그인" : "계정 만들기"}
              </button>
            </div>
          </form>
        </section>
      </div>

      <aside className="summary-panel profile-summary-panel">
        <h2>테스트 계정</h2>
        <dl>
          <div>
            <dt>Admin</dt>
            <dd>admin.user@asklake.local / asklake-admin</dd>
          </div>
          <div>
            <dt>Viewer</dt>
            <dd>demo.user@asklake.local / asklake-demo</dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}
