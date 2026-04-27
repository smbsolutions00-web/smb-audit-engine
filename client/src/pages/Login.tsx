import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Mail, Loader2, CheckCircle2, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/Logo";
import { apiRequest } from "@/lib/queryClient";

export default function Login() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus("sending");
    setErrorMsg("");
    try {
      await apiRequest("POST", "/api/auth/request-link", { email: email.trim() });
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Could not send sign-in email");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <Card className="w-full max-w-md border-card-border p-8">
        <div className="flex flex-col items-center text-center">
          <div className="mb-5 rounded-2xl border border-card-border bg-secondary p-3">
            <Logo variant="mark" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">SMB Audit Engine</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Sign in with a magic link sent to your email.
          </p>
        </div>

        {status === "sent" ? (
          <div
            className="mt-7 flex flex-col items-center rounded-lg border border-accent/30 bg-accent/10 px-5 py-6 text-center"
            data-testid="login-sent"
          >
            <CheckCircle2 className="h-7 w-7 text-accent" />
            <p className="mt-3 text-sm font-semibold">Check your inbox</p>
            <p className="mt-1 text-xs text-muted-foreground">
              If <span className="font-medium text-foreground">{email}</span> is on the allowlist, a sign-in link is on the way. The link expires in 15 minutes.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-4 text-xs"
              onClick={() => {
                setStatus("idle");
                setEmail("");
              }}
              data-testid="button-login-reset"
            >
              Use a different email
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-7 space-y-4">
            <div>
              <label htmlFor="email" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Email
              </label>
              <div className="relative mt-1.5">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={status === "sending"}
                  className="pl-9"
                  data-testid="input-login-email"
                />
              </div>
            </div>

            {status === "error" && errorMsg && (
              <p className="text-xs text-destructive" data-testid="login-error">
                {errorMsg}
              </p>
            )}

            <Button
              type="submit"
              className="w-full bg-accent text-accent-foreground hover:bg-accent/90"
              disabled={status === "sending"}
              data-testid="button-login-submit"
            >
              {status === "sending" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending link...
                </>
              ) : (
                <>
                  <Mail className="mr-2 h-4 w-4" />
                  Send sign-in link
                </>
              )}
            </Button>

            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Access is restricted to approved emails. Unknown addresses will not receive a link.
            </p>
          </form>
        )}
      </Card>
    </div>
  );
}
