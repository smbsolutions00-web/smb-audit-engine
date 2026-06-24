import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Logo } from "@/components/Logo";
import { Lock, Loader2, KeyRound, ShieldCheck } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface Props {
  email: string;
}

export default function ForcePasswordChange({ email }: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const queryClient = useQueryClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg("");

    if (newPassword.length < 8) {
      setStatus("error");
      setErrorMsg("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setStatus("error");
      setErrorMsg("New passwords do not match.");
      return;
    }
    if (newPassword === currentPassword) {
      setStatus("error");
      setErrorMsg("New password must be different from the temporary password.");
      return;
    }

    setStatus("submitting");
    try {
      await apiRequest("POST", "/api/auth/change-password", {
        currentPassword,
        newPassword,
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Could not change password");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <Card className="w-full max-w-md border-card-border p-8">
        <div className="flex flex-col items-center text-center">
          <div className="mb-5 rounded-2xl border border-card-border bg-secondary p-3">
            <Logo variant="mark" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">Set your password</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Signed in as <span className="font-medium text-foreground">{email}</span>.
            Choose a new password to continue.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-7 space-y-4">
          <div>
            <label
              htmlFor="currentPassword"
              className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Temporary password
            </label>
            <div className="relative mt-1.5">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="currentPassword"
                type="password"
                required
                autoFocus
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={status === "submitting"}
                className="pl-9"
                data-testid="input-current-password"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="newPassword"
              className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              New password (8+ characters)
            </label>
            <div className="relative mt-1.5">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="newPassword"
                type="password"
                required
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={status === "submitting"}
                className="pl-9"
                data-testid="input-new-password"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="confirmPassword"
              className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Confirm new password
            </label>
            <div className="relative mt-1.5">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="confirmPassword"
                type="password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={status === "submitting"}
                className="pl-9"
                data-testid="input-confirm-password"
              />
            </div>
          </div>

          {status === "error" && errorMsg && (
            <p className="text-xs text-destructive" data-testid="change-password-error">
              {errorMsg}
            </p>
          )}

          <Button
            type="submit"
            className="w-full bg-accent text-accent-foreground hover:bg-accent/90"
            disabled={status === "submitting"}
            data-testid="button-change-password"
          >
            {status === "submitting" ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <ShieldCheck className="mr-2 h-4 w-4" />
                Save new password
              </>
            )}
          </Button>
        </form>
      </Card>
    </div>
  );
}
