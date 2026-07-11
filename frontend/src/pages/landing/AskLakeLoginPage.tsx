import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router";

export function AskLakeLoginPage() {
  const navigate = useNavigate();

  const signIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigate("/jobs");
  };

  return (
    <main className="login-page">
      <Link className="login-brand" to="/" aria-label="AskLake 랜딩으로 돌아가기">
        <img alt="" aria-hidden="true" src="/asklake-wave-icon.png" />
        <strong>AskLake</strong>
      </Link>
      <p className="login-tagline">The Complete Data Pipeline Platform</p>

      <form className="login-card" onSubmit={signIn}>
        <h1>Sign In</h1>
        <label>
          <span>Email</span>
          <input autoComplete="email" inputMode="email" name="email" placeholder="you@example.com" required type="text" />
        </label>
        <label>
          <span>Password</span>
          <input autoComplete="current-password" name="password" placeholder="••••••••" required type="password" />
        </label>
        <button type="submit">Sign In</button>
        <small>Demo mode · any email and password will work.</small>
      </form>
    </main>
  );
}
