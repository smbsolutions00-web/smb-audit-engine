import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/AppShell";
import { AuthGate } from "@/components/AuthGate";
import Dashboard from "@/pages/Dashboard";
import NewAudit from "@/pages/NewAudit";
import Processing from "@/pages/Processing";
import Report from "@/pages/Report";
import Settings from "@/pages/Settings";
import AdminUsers from "@/pages/AdminUsers";
import NotFound from "@/pages/not-found";

function AppRouter() {
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/new" component={NewAudit} />
        <Route path="/processing/:id" component={Processing} />
        <Route path="/audit/:id" component={Report} />
        <Route path="/settings" component={Settings} />
        <Route path="/admin/users" component={AdminUsers} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AuthGate>
          <Router hook={useHashLocation}>
            <AppRouter />
          </Router>
        </AuthGate>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
