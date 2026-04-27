import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard, FilePlus2, Settings as SettingsIcon, LogOut } from "lucide-react";
import { Logo } from "./Logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { apiRequest, queryClient } from "@/lib/queryClient";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, testId: "link-dashboard" },
  { href: "/new", label: "New Audit", icon: FilePlus2, testId: "link-new-audit" },
  { href: "/settings", label: "Settings", icon: SettingsIcon, testId: "link-settings" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-background">
      {/* Top header — SMB branded */}
      <header className="sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur supports-[backdrop-filter]:bg-card/70">
        <div className="mx-auto flex h-20 max-w-[1400px] items-center justify-between px-4 sm:px-6">
          <Link href="/" className="hover-elevate -m-1.5 rounded-md p-1.5">
            {/* Show the icon-only mark on very narrow screens, full wordmark from sm+ */}
            <span className="sm:hidden">
              <Logo variant="mark" />
            </span>
            <span className="hidden sm:inline-flex">
              <Logo />
            </span>
          </Link>
          <div className="hidden items-center gap-1 md:flex">
            {navItems.map((item) => {
              const active = location === item.href;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  data-testid={item.testId}
                  className={cn(
                    "hover-elevate inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
                    active
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
            <UserMenu />
          </div>
        </div>
        {/* Mobile nav */}
        <div className="border-t border-border md:hidden">
          <div className="mx-auto flex max-w-[1400px] gap-1 overflow-x-auto px-3 py-2">
            {navItems.map((item) => {
              const active = location === item.href;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  data-testid={`mobile-${item.testId}`}
                  className={cn(
                    "hover-elevate inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium",
                    active
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 sm:py-10">{children}</main>

      <UserMenuMobile />

      <footer className="border-t border-border bg-card/40 py-6 text-center text-xs text-muted-foreground">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6">
          SMB Audit Engine · Internal Tool · © {new Date().getFullYear()} SMB Solutions
        </div>
      </footer>
    </div>
  );
}

interface AuthMe { authEnabled: boolean; signedIn: boolean; email: string | null; }

async function signOut() {
  await apiRequest("POST", "/api/auth/logout");
  queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
  // Hard reload to fully reset client cache + SPA state
  window.location.href = "/";
}

function UserMenu() {
  const { data } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"], staleTime: 60_000 });
  if (!data?.authEnabled || !data.signedIn) return null;
  return (
    <div className="ml-2 flex items-center gap-2 border-l border-border pl-3">
      <span className="max-w-[180px] truncate text-xs text-muted-foreground" title={data.email || ""}>
        {data.email}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={signOut}
        data-testid="button-signout"
        className="h-8 px-2 text-muted-foreground hover:text-foreground"
      >
        <LogOut className="h-3.5 w-3.5" />
        <span className="sr-only">Sign out</span>
      </Button>
    </div>
  );
}

function UserMenuMobile() {
  const { data } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"], staleTime: 60_000 });
  if (!data?.authEnabled || !data.signedIn) return null;
  return (
    <div className="border-b border-border bg-secondary/40 px-4 py-2 text-xs text-muted-foreground md:hidden">
      <div className="flex items-center justify-between">
        <span className="truncate">Signed in as {data.email}</span>
        <button
          onClick={signOut}
          className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
          data-testid="button-signout-mobile"
        >
          <LogOut className="h-3 w-3" />
          Sign out
        </button>
      </div>
    </div>
  );
}
