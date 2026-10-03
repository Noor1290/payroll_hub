import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { CircleAlert, Clock, Eye, EyeOff, FlaskConical, LoaderCircle, Lock } from "lucide-react";
import { Navigate, useLocation } from "react-router-dom";
import { AuroraBackground, LogoMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/misc";
import { idleMinutes } from "@/lib/preferences";
import { supabase } from "@/lib/supabase/client";
import { useAuth, type SignOutNotice } from "./auth-context";
import { authFailure, type AuthFailure } from "./authErrors";

function noticeText(notice: SignOutNotice): string {
  if (notice === "expired") return "Your session ended. Sign in again to continue.";
  const minutes = idleMinutes.get();
  return `You were signed out after ${minutes === 1 ? "1 minute" : `${minutes} minutes`} of inactivity.`;
}

function redirectTarget(state: unknown): string {
  if (typeof state === "object" && state !== null && "from" in state) {
    const from = (state as { from: unknown }).from;
    if (typeof from === "string" && from.startsWith("/") && from !== "/login") return from;
  }
  return "/";
}

export function LoginPage() {
  const { status, notice, signIn, signInDemo, clearNotice } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(
    supabase ? null : authFailure("not-configured"),
  );
  const errorRef = useRef<HTMLDivElement>(null);
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  useEffect(() => {
    if (failure) errorRef.current?.focus();
  }, [failure]);

  if (status === "signed-in") return <Navigate to={redirectTarget(location.state)} replace />;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFailure(null);
    clearNotice();
    const result = await signIn(email.trim(), password);
    setSubmitting(false);
    if (result) {
      setFailure(result);
      setPassword("");
    }
  };

  const formDisabled = !supabase;

  return (
    <div className="relative h-full overflow-y-auto">
      <AuroraBackground className="fixed" />
      <main className="relative mx-auto grid min-h-full w-full max-w-6xl items-center gap-12 px-6 py-12 lg:grid-cols-[1.1fr_1fr]">
        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="hidden lg:block"
        >
          <div className="flex items-center gap-3">
            <LogoMark className="size-10" />
            <span className="text-lg font-semibold tracking-tight">Payroll Hub</span>
          </div>
          <p className="mt-10 max-w-lg text-5xl leading-[1.08] font-semibold tracking-tight text-balance">
            One control room for every payroll app.
          </p>
          <p className="mt-5 max-w-md text-lg leading-relaxed text-muted">
            Import results, review them, and send exactly the rows and columns each app needs.
          </p>
          <ul className="mt-10 space-y-3 text-sm text-muted">
            {[
              "Payroll figures stay in memory and are wiped when you sign out.",
              "Access is decided per company by the database, not by this page.",
              "Each app keeps working on its own if the hub is unavailable.",
            ].map((line) => (
              <li key={line} className="flex items-start gap-3">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                {line}
              </li>
            ))}
          </ul>
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.08, ease: "easeOut" }}
          aria-labelledby="login-heading"
          className="glass mx-auto w-full max-w-md rounded-2xl p-7 shadow-pop sm:p-9"
        >
          <div className="mb-7 flex items-center gap-3 lg:hidden">
            <LogoMark />
            <span className="font-semibold tracking-tight">Payroll Hub</span>
          </div>
          <h1 id="login-heading" className="text-2xl font-semibold tracking-tight">
            Sign in
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            Accounts are by invitation. Ask the owner if you need access.
          </p>

          {notice && !failure && (
            <div
              role="status"
              className="mt-6 flex items-start gap-3 rounded-lg border border-warn/30 bg-warn/10 p-3.5 text-sm text-fg"
            >
              <Clock className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
              {noticeText(notice)}
            </div>
          )}

          {failure && (
            <div
              ref={errorRef}
              id={errorId}
              role="alert"
              tabIndex={-1}
              className="mt-6 flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/10 p-3.5 text-sm outline-none"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
              <div>
                <p className="font-medium text-fg">{failure.title}</p>
                <p className="mt-1 text-muted">{failure.message}</p>
              </div>
            </div>
          )}

          {status === "loading" ? (
            <div className="mt-6 space-y-5" aria-busy="true" aria-label="Checking your session">
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
          ) : (
            <form onSubmit={onSubmit} className="mt-6 space-y-5">
              <div className="space-y-2">
                <Label htmlFor={emailId}>Email</Label>
                <Input
                  id={emailId}
                  type="email"
                  name="email"
                  autoComplete="username"
                  inputMode="email"
                  required
                  disabled={formDisabled || submitting}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-describedby={failure ? errorId : undefined}
                  placeholder="you@company.com"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={passwordId}>Password</Label>
                <div className="relative">
                  <Input
                    id={passwordId}
                    type={showPassword ? "text" : "password"}
                    name="password"
                    autoComplete="current-password"
                    required
                    disabled={formDisabled || submitting}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-describedby={failure ? errorId : undefined}
                    className="pr-11"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                    disabled={formDisabled}
                    className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-lg text-subtle hover:text-fg disabled:opacity-50"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>
              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="w-full"
                disabled={formDisabled || submitting}
              >
                {submitting ? (
                  <>
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                    Signing in
                  </>
                ) : (
                  <>
                    <Lock aria-hidden="true" />
                    Sign in
                  </>
                )}
              </Button>
            </form>
          )}

          {/* import.meta.env.DEV is a build-time constant, so production builds drop this block entirely. */}
          {import.meta.env.DEV && signInDemo && (
            <div className="mt-6 border-t border-line pt-6">
              <Button variant="secondary" size="lg" className="w-full" onClick={signInDemo}>
                <FlaskConical aria-hidden="true" />
                Enter demo workspace
              </Button>
              <p className="mt-2.5 text-center text-xs text-subtle">
                Development only. Fake data, no database. Not available in production builds.
              </p>
            </div>
          )}
        </motion.section>
      </main>
    </div>
  );
}
