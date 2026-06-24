import { useQuery } from "@tanstack/react-query";
import Login from "@/pages/Login";
import ForcePasswordChange from "@/pages/ForcePasswordChange";
import { Loader2 } from "lucide-react";

interface AuthMe {
  authEnabled: boolean;
  signedIn: boolean;
  email: string | null;
  role: "admin" | "member" | null;
  mustChange: boolean;
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useQuery<AuthMe>({
    queryKey: ["/api/auth/me"],
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Auth disabled (local dev), pass through
  if (!data || !data.authEnabled) return <>{children}</>;

  if (!data.signedIn) return <Login />;

  if (data.mustChange) return <ForcePasswordChange email={data.email || ""} />;

  return <>{children}</>;
}
