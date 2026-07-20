import { useCallback, useState } from "react";
import { useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { SpinnerGap, WarningCircle } from "@phosphor-icons/react";

/**
 * Auth form for sign in / sign up with email + password.
 * Fits into the app's visual language: Instrument Sans, paper/ink palette.
 */
export function AuthForm() {
  const { signIn, signUp } = useAuthActions();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async (event) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      if (isSignUp) {
        await signUp("password", {
          email: email.trim(),
          password,
          name: name.trim() || undefined,
        });
      } else {
        await signIn("password", {
          email: email.trim(),
          password,
        });
      }
    } catch (err) {
      const message = err.message || "Could not sign in. Check your credentials.";
      setError(message.replace(/^ConvexError:\s*/, ""));
    } finally {
      setSubmitting(false);
    }
  }, [isSignUp, email, password, name, signIn, signUp]);

  const handleGitHub = useCallback(async () => {
    setError("");
    try {
      await signIn("github");
    } catch (err) {
      setError(err.message || "GitHub sign-in failed.");
    }
  }, [signIn]);

  const handleGoogle = useCallback(async () => {
    setError("");
    try {
      await signIn("google");
    } catch (err) {
      setError(err.message || "Google sign-in failed.");
    }
  }, [signIn]);

  if (isAuthenticated) return null;
  if (isLoading) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <SpinnerGap size={24} className="import-spinner" />
          <p>Loading&hellip;</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1 className="auth-title">{isSignUp ? "Create account" : "Sign in"}</h1>
        <p className="auth-subtitle">{isSignUp ? "Start your private wardrobe" : "Welcome back to your wardrobe"}</p>

        {/* OAuth buttons */}
        <div className="auth-oauth-row">
          <button className="auth-oauth-button" type="button" onClick={handleGitHub}>GitHub</button>
          <button className="auth-oauth-button" type="button" onClick={handleGoogle}>Google</button>
        </div>

        <div className="auth-divider"><span>or</span></div>

        {/* Email + password form */}
        <form className="auth-form" onSubmit={handleSubmit}>
          {isSignUp && (
            <div className="auth-field">
              <label htmlFor="auth-name">Name</label>
              <input id="auth-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" />
            </div>
          )}
          <div className="auth-field">
            <label htmlFor="auth-email">Email</label>
            <input id="auth-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required />
          </div>
          <div className="auth-field">
            <label htmlFor="auth-password">Password</label>
            <input id="auth-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isSignUp ? "At least 8 characters" : "Your password"} autoComplete={isSignUp ? "new-password" : "current-password"} required minLength={8} />
          </div>
          <button className="auth-submit" type="submit" disabled={submitting}>
            {submitting ? <SpinnerGap size={18} className="import-spinner" /> : isSignUp ? "Create account" : "Sign in"}
          </button>
        </form>

        {error && <p className="auth-error"><WarningCircle size={14} /> {error}</p>}

        <p className="auth-toggle">
          {isSignUp
            ? <>Already have an account? <button type="button" onClick={() => { setIsSignUp(false); setError(""); }}>Sign in</button></>
            : <>No account yet? <button type="button" onClick={() => { setIsSignUp(true); setError(""); }}>Create one</button></>
          }
        </p>
      </div>
    </div>
  );
}
