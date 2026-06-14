import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FilePlus2,
  Loader2,
  Trash2,
  FileText,
  RefreshCw,
  TrendingUp,
  Sparkles,
  ArrowRight,
  CheckCircle2,
  MoreVertical,
  Send,
} from "lucide-react";
import {
  type AuditSummary,
  formatDate,
  gradeBg,
  gradeColor,
  averageGrade,
} from "@/lib/utils-audit";

export default function Dashboard() {
  const { data: audits, isLoading } = useQuery<AuditSummary[]>({
    queryKey: ["/api/audits"],
    refetchInterval: (q) => {
      const data = q.state.data as AuditSummary[] | undefined;
      return data?.some((a) => a.status === "processing") ? 4000 : false;
    },
  });

  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/audits/${id}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/audits"] }),
  });

  const retryMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/audits/${id}/retry`);
      return res.json() as Promise<{ id: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/audits"] });
      setLocation(`/processing/${data.id}`);
    },
    onError: (err: Error) => {
      toast({
        variant: "destructive",
        title: "Could not retry",
        description: err.message || "Please start a new audit instead.",
      });
    },
  });

  const deliveredMutation = useMutation({
    mutationFn: async ({ id, delivered }: { id: string; delivered: boolean }) => {
      await apiRequest("PATCH", `/api/audits/${id}/delivered`, { delivered });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/audits"] }),
  });

  /* Stats */
  const completed = (audits || []).filter((a) => a.status === "complete");
  const totalCount = (audits || []).length;
  const deliveredCount = completed.filter((a) => a.delivered).length;
  const portfolioGrade = averageGrade(completed.map((a) => a.overallGrade));

  return (
    <div className="space-y-8">
      {/* Hero banner */}
      <section
        className="relative overflow-hidden rounded-2xl px-7 py-9 text-white shadow-sm md:px-10 md:py-11"
        style={{
          background:
            "linear-gradient(135deg, hsl(218 60% 18%) 0%, hsl(218 70% 26%) 55%, hsl(212 65% 32%) 100%)",
        }}
      >
        {/* subtle radial accent */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full opacity-20 blur-3xl"
          style={{ background: "hsl(197 80% 60%)" }}
        />
        <div className="relative flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium backdrop-blur-sm">
              <Sparkles className="h-3.5 w-3.5" />
              Four-Pillar Audit Engine
            </div>
            <h1 className="mt-4 text-3xl font-bold leading-tight tracking-tight md:text-4xl">
              Turn intake docs into client-ready audits.
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/80 md:text-base">
              Upload an intake form, the SMB Solution Audit snapshot, and your client&apos;s URL to get a full Four-Pillar report and an immediate plan of action in minutes.
            </p>
          </div>
          <Link href="/new">
            <Button
              size="lg"
              className="bg-white text-slate-900 hover:bg-white/90"
              data-testid="button-hero-new-audit"
            >
              <FilePlus2 className="mr-2 h-4 w-4" />
              Start a New Audit
            </Button>
          </Link>
        </div>
      </section>

      {/* Stat cards */}
      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Total Audits"
          value={isLoading ? "—" : String(totalCount)}
          sub="All time"
          icon={<FileText className="h-5 w-5" />}
        />
        <StatCard
          label="Delivered"
          value={isLoading ? "—" : String(deliveredCount)}
          sub="Sent to clients"
          icon={<TrendingUp className="h-5 w-5" />}
        />
        <StatCard
          label="Avg. Overall Grade"
          value={isLoading ? "—" : portfolioGrade}
          sub="Across portfolio"
          icon={<Sparkles className="h-5 w-5" />}
          accent
        />
      </section>

      {/* Recent audits */}
      <section>
        <div className="mb-4">
          <h2 className="text-xl font-semibold tracking-tight">Recent audits</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Past Four-Pillar reports across your client portfolio.
          </p>
        </div>

        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-44 w-full rounded-xl" />
            ))}
          </div>
        ) : !audits || audits.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {audits.map((audit) => (
              <AuditCard
                key={audit.id}
                audit={audit}
                onDelete={() => deleteMutation.mutate(audit.id)}
                onRetry={() => retryMutation.mutate(audit.id)}
                onToggleDelivered={() =>
                  deliveredMutation.mutate({ id: audit.id, delivered: !audit.delivered })
                }
                isRetrying={retryMutation.isPending && retryMutation.variables === audit.id}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------- StatCard ------------------------------- */

function StatCard({
  label,
  value,
  sub,
  icon,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <Card className="flex items-start justify-between gap-4 rounded-xl border-card-border p-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p
          className="mt-2 text-3xl font-bold tabular-nums tracking-tight"
          data-testid={`stat-${label.toLowerCase().replace(/\s+/g, "-")}`}
        >
          {value}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
      </div>
      <div
        className={
          "flex h-10 w-10 items-center justify-center rounded-lg " +
          (accent
            ? "bg-accent/15 text-accent"
            : "bg-secondary text-muted-foreground")
        }
      >
        {icon}
      </div>
    </Card>
  );
}

/* ------------------------------- AuditCard ------------------------------ */

function AuditCard({
  audit,
  onDelete,
  onRetry,
  onToggleDelivered,
  isRetrying,
}: {
  audit: AuditSummary;
  onDelete: () => void;
  onRetry: () => void;
  onToggleDelivered: () => void;
  isRetrying: boolean;
}) {
  const isProcessing = audit.status === "processing";
  const isFailed = audit.status === "failed";
  const isComplete = audit.status === "complete";

  const websiteHost = audit.clientWebsite.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const meta = [websiteHost, audit.industry, audit.location].filter(Boolean).join(" · ");

  const pillars = [
    { key: "ai", label: "AI", grade: audit.pillarGrades?.aiAutomation ?? null },
    { key: "seo", label: "SEO", grade: audit.pillarGrades?.seoListings ?? null },
    { key: "rep", label: "Rep.", grade: audit.pillarGrades?.reputation ?? null },
    { key: "social", label: "Social", grade: audit.pillarGrades?.socialMedia ?? null },
  ];

  return (
    <Card
      className="group flex flex-col gap-4 rounded-xl border-card-border p-5 transition-colors hover:border-accent/40"
      data-testid={`card-audit-${audit.id}`}
    >
      {/* Header row */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              className="truncate text-base font-semibold tracking-tight"
              data-testid={`text-client-${audit.id}`}
            >
              {audit.clientName}
            </h3>
            {isProcessing && (
              <Badge variant="secondary" className="border-0 bg-accent/15 text-accent">
                Processing
              </Badge>
            )}
            {isFailed && <Badge variant="destructive">Failed</Badge>}
            {isComplete && audit.delivered && (
              <Badge
                className="border-0"
                style={{
                  background: "hsl(152 63% 46% / 0.15)",
                  color: "hsl(152 63% 36%)",
                }}
              >
                DELIVERED
              </Badge>
            )}
            {isComplete && !audit.delivered && (
              <Badge
                className="border-0"
                style={{
                  background: "hsl(152 63% 46% / 0.12)",
                  color: "hsl(152 63% 36%)",
                }}
              >
                READY
              </Badge>
            )}
          </div>
          {meta && (
            <p className="mt-1 truncate text-xs text-muted-foreground">{meta}</p>
          )}
        </div>

        {/* Overall grade chip */}
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-base font-bold tabular-nums"
          style={{
            background: isProcessing || isFailed
              ? "hsl(var(--secondary))"
              : gradeBg(audit.overallGrade || ""),
            color: isProcessing || isFailed
              ? "hsl(var(--muted-foreground))"
              : gradeColor(audit.overallGrade || ""),
          }}
          data-testid={`grade-overall-${audit.id}`}
        >
          {isProcessing ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : isFailed ? (
            "N/A"
          ) : (
            audit.overallGrade || "N/A"
          )}
        </div>

        {/* Card menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              data-testid={`button-card-menu-${audit.id}`}
            >
              <MoreVertical className="h-4 w-4 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {isComplete && (
              <DropdownMenuItem onClick={onToggleDelivered}>
                {audit.delivered ? (
                  <>
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Mark as Ready
                  </>
                ) : (
                  <>
                    <Send className="mr-2 h-4 w-4" />
                    Mark as Delivered
                  </>
                )}
              </DropdownMenuItem>
            )}
            {isFailed && (
              <DropdownMenuItem onClick={onRetry} disabled={isRetrying}>
                {isRetrying ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Retry audit
              </DropdownMenuItem>
            )}
            {isComplete && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <DropdownMenuItem
                    onSelect={(e) => e.preventDefault()}
                    disabled={isRetrying}
                  >
                    {isRetrying ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    Rerun audit
                  </DropdownMenuItem>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Rerun this audit?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This regenerates the report for {audit.clientName} using the original intake and audit data. The existing report will be replaced.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={onRetry}>
                      Rerun
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {(isComplete || isFailed) && <DropdownMenuSeparator />}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <DropdownMenuItem
                  onSelect={(e) => e.preventDefault()}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete audit
                </DropdownMenuItem>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this audit?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently removes the audit for {audit.clientName}. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={onDelete}
                    className="bg-destructive text-destructive-foreground"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Pillar grades row */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {pillars.map((p) => (
          <PillarChip key={p.key} label={p.label} grade={p.grade} />
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border pt-3">
        <span className="text-xs text-muted-foreground">
          Created {formatDate(audit.createdAt)}
        </span>
        {isComplete && (
          <Link
            href={`/audit/${audit.id}`}
            className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:text-accent/80"
            data-testid={`link-open-${audit.id}`}
          >
            Open report
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
        {isProcessing && (
          <Link
            href={`/processing/${audit.id}`}
            className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:text-accent/80"
            data-testid={`link-track-${audit.id}`}
          >
            Track progress
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
        {isFailed && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            disabled={isRetrying}
            data-testid={`button-retry-${audit.id}`}
          >
            {isRetrying ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            )}
            Retry
          </Button>
        )}
      </div>
    </Card>
  );
}

function PillarChip({ label, grade }: { label: string; grade: string | null }) {
  const display = grade || "N/A";
  const isMissing = !grade;
  return (
    <div
      className="flex items-center justify-between rounded-md border border-card-border bg-secondary/40 px-2.5 py-1.5"
      data-testid={`pillar-${label.toLowerCase()}`}
    >
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span
        className="flex h-6 min-w-[1.75rem] items-center justify-center rounded px-1.5 text-xs font-bold tabular-nums"
        style={{
          background: isMissing ? "hsl(var(--muted))" : gradeBg(display),
          color: isMissing ? "hsl(var(--muted-foreground))" : gradeColor(display),
        }}
      >
        {display}
      </span>
    </div>
  );
}

/* ------------------------------- EmptyState ----------------------------- */

function EmptyState() {
  return (
    <Card className="border-card-border">
      <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-secondary">
          <FileText className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="text-base font-semibold">No audits yet</h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Upload your first Client Intake Form and SMB Solution Audit to generate a Four-Pillar audit report.
        </p>
        <Link href="/new" className="mt-6">
          <Button
            className="bg-accent text-accent-foreground hover:bg-accent/90"
            data-testid="button-empty-new-audit"
          >
            <FilePlus2 className="mr-2 h-4 w-4" />
            Start an audit
          </Button>
        </Link>
      </div>
    </Card>
  );
}
