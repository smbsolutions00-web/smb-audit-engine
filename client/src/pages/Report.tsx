import { useState, useRef, useEffect } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Pencil } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ArrowLeft,
  Printer,
  ChevronDown,
  Loader2,
  Database,
  Upload,
  FileDown,
  Sparkle,
  Check,
  X,
  AlertTriangle,
  TrendingUp,
  Search,
  Sparkles,
  Save,
  RotateCw,
  Eye,
  Clock,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Send,
  Star,
  Globe,
  Users,
  Calendar,
  Award,
  ShieldAlert,
  Bot,
  MapPin,
  Phone,
  Zap,
  Target,
  Presentation,
  Image as ImageIcon,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type {
  ReportData,
  PillarReport,
  KeywordRow,
  ListingRow,
  AiAutomationPillar,
  CoreWebVital,
  ImmediateActionItem,
  ImmediateActionPlan,
  AuditEvent,
  AuditEventType,
} from "@shared/schema";
import { gradeBg, gradeColor, formatDate, formatNumber, formatCurrency } from "@/lib/utils-audit";
import { Logo } from "@/components/Logo";
import jsPDF from "jspdf";

interface IntakeShape {
  clientName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  website?: string;
  industry?: string;
  location?: string;
  address?: string;
  manusPdfPath?: string;
  manusPdfUploadedAt?: number;
  finalDeliverableFormat?: string;
}

interface AuditDetail {
  id: string;
  clientName: string;
  clientWebsite: string;
  industry?: string | null;
  location?: string | null;
  status: string;
  overallGrade?: string | null;
  overallScore?: number | null;
  createdAt: number;
  reportData?: ReportData | null;
  intakeData?: IntakeShape | null;
  eventLog?: AuditEvent[];
  hasEditedScript?: boolean;
}

export default function Report() {
  const [, params] = useRoute("/audit/:id");
  const id = params?.id || "";
  const reportRef = useRef<HTMLDivElement>(null);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const { toast } = useToast();

  const handleDownloadPdf = async () => {
    if (!data || !data.reportData) return;
    setIsGeneratingPdf(true);

    const clientSlug = (data.clientName || "audit")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    try {
      const pdf = buildStructuredPdf(data);
      pdf.save(`digital-presence-audit-${clientSlug}.pdf`);
    } catch (err) {
      console.error("PDF generation failed", err);
      toast({
        title: "PDF generation failed",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const handleDownloadMarkdown = () => {
    if (!data || !data.reportData) return;
    const clientSlug = (data.clientName || "audit")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const md = buildMarkdownOutline(data);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `digital-presence-audit-${clientSlug}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleManusFormatChange = (value: string) => {
    if (value === "pdf") {
      handleDownloadPdf();
    } else if (value === "markdown") {
      handleDownloadMarkdown();
    }
  };

  const { data, isLoading } = useQuery<AuditDetail>({
    queryKey: ["/api/audits", id],
    enabled: !!id,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/audits/${id}`);
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!data || !data.reportData) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm text-muted-foreground">Report not available.</p>
      </Card>
    );
  }

  const r = data.reportData;
  const intake = data.intakeData ?? {};
  // The 4 pillars in the order they appear in the overview grid (unchanged).
  const pillars = [
    { key: "aiAutomation", icon: Bot, data: r.pillars.aiAutomation as PillarReport },
    { key: "seoListings", icon: Search, data: r.pillars.seoListings },
    { key: "reputation", icon: Star, data: r.pillars.reputation },
    { key: "socialMedia", icon: Users, data: r.pillars.socialMedia },
  ];
  // The detail order: AI Automation → Reputation → Social Media → (Deep SEO at end).
  // SEO + Listings is shown LAST (after social) per Krystal's request — it lives in SeoDeepSection,
  // and the SEO + Listings pillar detail card is folded in there too.
  const detailPillars = [
    { key: "aiAutomation", icon: Bot, data: r.pillars.aiAutomation as PillarReport, ai: r.pillars.aiAutomation as AiAutomationPillar },
    { key: "reputation", icon: Star, data: r.pillars.reputation, ai: undefined },
    { key: "socialMedia", icon: Users, data: r.pillars.socialMedia, ai: undefined },
  ];

  return (
    <div className="space-y-8" ref={reportRef}>
      {/* Action bar */}
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <Link href="/">
          <Button variant="ghost" size="sm" data-testid="button-back">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Dashboard
          </Button>
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              const el = document.getElementById("client-facing-deck");
              if (el) {
                el.scrollIntoView({ behavior: "smooth", block: "start" });
                // Soft highlight pulse so the user can see where they landed.
                el.classList.add("ring-2", "ring-accent", "ring-offset-2");
                setTimeout(() => {
                  el.classList.remove("ring-2", "ring-accent", "ring-offset-2");
                }, 1800);
              }
            }}
            className="bg-accent text-accent-foreground hover:bg-accent/90"
            data-testid="button-jump-to-manus"
          >
            <Send className="mr-1.5 h-4 w-4" />
            Send to Manus
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownloadPdf}
            disabled={isGeneratingPdf}
            data-testid="button-print"
          >
            <Printer className="mr-1.5 h-4 w-4" />
            {isGeneratingPdf ? "Generating PDF…" : "Download PDF"}
          </Button>
          <Select onValueChange={handleManusFormatChange}>
            <SelectTrigger
              className="h-9 w-[210px] text-sm"
              data-testid="select-download-manus"
            >
              <FileDown className="mr-1.5 h-4 w-4" />
              <SelectValue placeholder="Download for Manus" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pdf" data-testid="manus-format-pdf">
                Structured PDF (current)
              </SelectItem>
              <SelectItem value="markdown" data-testid="manus-format-markdown">
                Outline Markdown
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Cover */}
      <Card className="page-break overflow-hidden border-card-border">
        {/* Navy header band: transparent PNG logo sits directly on the navy, no white box */}
        <div className="bg-[hsl(var(--sidebar))] px-8 pb-7 pt-8 text-white">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Logo hideSublabel className="h-14 w-auto object-contain" />
            <div className="text-right text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
              SMB Solutions · Internal Tool
            </div>
          </div>
          <div className="mt-7">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
              Digital Presence Audit
            </p>
            <h1 className="mt-1.5 text-3xl font-bold tracking-tight md:text-4xl">
              The Four-Pillar Report
            </h1>
            <p className="mt-2 max-w-prose text-sm text-white/70">
              An executive view of how this business shows up across AI assistants, search,
              reputation, and social, with a clear immediate plan of action.
            </p>
          </div>
        </div>

        {/* Client identity card */}
        <div className="grid gap-6 p-8 md:grid-cols-[1fr_auto] md:items-end">
          <div>
            <div className="flex items-center justify-between gap-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
                Audit prepared for
              </p>
              <div className="flex items-center gap-1">
                <KeysearchPullButton auditId={data.id} />
                <EditBusinessInfoButton audit={data} />
              </div>
            </div>
            <h2 className="mt-1 text-2xl font-bold tracking-tight md:text-3xl" data-testid="text-client-name">
              {data.clientName}
            </h2>

            {/* NAP: Name, Address, Phone (plus website) */}
            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex items-start gap-2 text-muted-foreground">
                <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span data-testid="text-website">{data.clientWebsite}</span>
              </div>
              {(intake.address || data.location) && (
                <div className="flex items-start gap-2 text-muted-foreground">
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span data-testid="text-address">{intake.address || data.location}</span>
                </div>
              )}
              {intake.phone && (
                <div className="flex items-start gap-2 text-muted-foreground">
                  <Phone className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span data-testid="text-phone">{intake.phone}</span>
                </div>
              )}
            </dl>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {data.industry && <span>{data.industry}</span>}
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" />
                {formatDate(data.createdAt)}
              </span>
            </div>
          </div>
          <OverallGradeBadge grade={data.overallGrade} score={data.overallScore} />
        </div>
      </Card>

      {/* Executive summary */}
      <Card className="border-card-border p-6 md:p-8">
        <SectionLabel icon={Sparkles}>Executive summary</SectionLabel>
        <p className="mt-4 max-w-prose text-base leading-relaxed">
          {r.executiveSummary.diagnosis}
        </p>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <ListBlock
            icon={Award}
            tone="success"
            title="Top wins"
            items={r.executiveSummary.topWins}
          />
          <ListBlock
            icon={ShieldAlert}
            tone="danger"
            title="Top risks"
            items={r.executiveSummary.topRisks}
          />
        </div>
      </Card>

      {/* Pillars overview grid */}
      <section>
        <SectionLabel icon={TrendingUp}>The Four Pillars</SectionLabel>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {pillars.map(({ key, icon: Icon, data: p }) => (
            <PillarSummaryCard key={key} pillar={p} icon={Icon} />
          ))}
        </div>
      </section>

      {/* Pillar details: AI Automation → Reputation → Social Media (SEO is last, inside Deep SEO section) */}
      {detailPillars.map(({ key, icon, data: p, ai }) => (
        <PillarDetail
          key={key}
          pillar={p}
          icon={icon}
          aiPlatforms={ai?.platforms}
        />
      ))}

      {/* SEO + Listings pillar detail folded into the Deep SEO section so SEO lands LAST */}
      <SeoDeepSection seo={r.seoDeep} pillar={r.pillars.seoListings} />

      {/* Website performance — upsell, plain-English vitals */}
      <WebsitePerformanceSection wp={r.websitePerformance} />

      {/* Immediate Action Plan (replaces 90-day plan) */}
      <ImmediateActionPlanSection plan={r.immediateActionPlan} />

      {/* Client-Facing Deck — async Manus Slides export */}
      <ClientFacingDeckCard auditId={data.id} />

      {/* Final client deliverable hand-off (Manus PDF upload) */}
      <FinalDeliverableSection
        auditId={data.id}
        uploadedAt={data.intakeData?.manusPdfUploadedAt ?? null}
      />

      {/* Activity timeline (audit events with timestamps) */}
      <ActivityTimeline
        events={data.eventLog || []}
        createdAt={data.createdAt}
      />

    </div>
  );
}

/* ---------- Sub-components ---------- */

function SectionLabel({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-accent" />
      <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-accent">{children}</h2>
    </div>
  );
}

function OverallGradeBadge({ grade, score }: { grade?: string | null; score?: number | null }) {
  const g = grade || "N/A";
  return (
    <div
      className="flex h-24 w-24 flex-col items-center justify-center rounded-2xl border border-card-border md:h-28 md:w-28"
      style={{ background: gradeBg(g), color: gradeColor(g) }}
      data-testid="overall-grade"
    >
      <div className="text-3xl font-bold tabular-nums leading-none md:text-4xl">{g}</div>
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] opacity-80">
        Overall
      </div>
      {score != null && (
        <div className="mt-0.5 text-xs font-medium tabular-nums opacity-80">{score}/100</div>
      )}
    </div>
  );
}

function ListBlock({
  icon: Icon,
  title,
  items,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  items: string[];
  tone: "success" | "danger" | "neutral";
}) {
  const accent =
    tone === "success"
      ? "text-accent"
      : tone === "danger"
        ? "text-destructive"
        : "text-muted-foreground";
  const bg =
    tone === "success"
      ? "bg-accent/10"
      : tone === "danger"
        ? "bg-destructive/10"
        : "bg-secondary";

  return (
    <div className="rounded-xl border border-card-border bg-secondary/30 p-5">
      <div className={`mb-3 inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs font-semibold ${bg} ${accent}`}>
        <Icon className="h-3.5 w-3.5" />
        {title}
      </div>
      <ul className="space-y-2">
        {items?.map((item, i) => (
          <li key={i} className="flex gap-2 text-sm leading-relaxed">
            <span className={`mt-2 h-1 w-1 shrink-0 rounded-full ${tone === "success" ? "bg-accent" : tone === "danger" ? "bg-destructive" : "bg-muted-foreground"}`} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PillarSummaryCard({
  pillar,
  icon: Icon,
}: {
  pillar: PillarReport;
  icon: React.ComponentType<{ className?: string }>;
}) {
  if (!pillar) return null;
  return (
    <Card className="hover-elevate flex flex-col gap-3 border-card-border p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Icon className="h-4 w-4" />
        </div>
        <div
          className="flex h-12 w-12 items-center justify-center rounded-lg font-bold"
          style={{ background: gradeBg(pillar.grade), color: gradeColor(pillar.grade) }}
        >
          {pillar.grade}
        </div>
      </div>
      <div>
        <div className="text-sm font-semibold">{pillar.name}</div>
        <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
          Score {pillar.score}/100
        </div>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full"
          style={{ width: `${pillar.score}%`, background: gradeColor(pillar.grade) }}
        />
      </div>
    </Card>
  );
}

function PillarDetail({
  pillar,
  icon: Icon,
  highlight,
  aiPlatforms,
}: {
  pillar: PillarReport;
  icon: React.ComponentType<{ className?: string }>;
  highlight?: boolean;
  aiPlatforms?: AiAutomationPillar["platforms"];
}) {
  if (!pillar) return null;
  return (
    <Card
      className={`border-card-border p-6 md:p-8 ${highlight ? "border-accent/40 ring-1 ring-accent/20" : ""}`}
      data-testid={`pillar-${pillar.name}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-bold">{pillar.name}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Score {pillar.score}/100 · Grade {pillar.grade}
              {highlight && " · Deepest pillar"}
            </p>
          </div>
        </div>
        <div
          className="flex h-14 w-14 items-center justify-center rounded-xl font-bold"
          style={{ background: gradeBg(pillar.grade), color: gradeColor(pillar.grade) }}
        >
          {pillar.grade}
        </div>
      </div>

      <p className="mt-4 text-sm leading-relaxed">{pillar.summary}</p>

      {/* AI platforms presence — only on the AI Automation pillar */}
      {aiPlatforms && aiPlatforms.length > 0 && (
        <div className="mt-5 rounded-xl border border-card-border bg-secondary/30 p-5">
          <div className="mb-3 text-xs font-bold uppercase tracking-wider text-accent">
            Surfacing on major AI assistants
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {aiPlatforms.map((p) => (
              <div
                key={p.platform}
                className="flex items-start gap-3 rounded-lg border border-card-border bg-card p-3"
                data-testid={`ai-platform-${p.platform.replace(/\s+/g, "-").toLowerCase()}`}
              >
                <div
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                    p.present ? "bg-accent/15 text-accent" : "bg-destructive/15 text-destructive"
                  }`}
                >
                  {p.present ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{p.platform}</div>
                  <div
                    className={`text-[11px] font-semibold uppercase tracking-wider ${
                      p.present ? "text-accent" : "text-destructive"
                    }`}
                  >
                    {p.present ? "Surfacing" : "Not surfacing"}
                  </div>
                  {p.notes && (
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{p.notes}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <SubList tone="success" title="Strengths" items={pillar.strengths} />
        <SubList tone="danger" title="Gaps" items={pillar.gaps} />
        <SubList tone="primary" title="Recommendations" items={pillar.recommendations} />
      </div>
    </Card>
  );
}

function SubList({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "success" | "danger" | "primary";
}) {
  const dot =
    tone === "success" ? "bg-accent" : tone === "danger" ? "bg-destructive" : "bg-foreground";
  const label =
    tone === "success" ? "text-accent" : tone === "danger" ? "text-destructive" : "text-foreground";
  return (
    <div>
      <div className={`mb-2 text-xs font-bold uppercase tracking-wider ${label}`}>{title}</div>
      <ul className="space-y-1.5">
        {items?.map((it, i) => (
          <li key={i} className="flex gap-2 text-sm leading-relaxed">
            <span className={`mt-2 h-1 w-1 shrink-0 rounded-full ${dot}`} />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SeoDeepSection({
  seo,
  pillar,
}: {
  seo: ReportData["seoDeep"];
  pillar?: PillarReport;
}) {
  if (!seo && !pillar) return null;
  return (
    <Card
      className="border-card-border border-accent/40 p-6 ring-1 ring-accent/20 md:p-8"
      data-testid="section-seo-deep"
    >
      {/* Combined header: pillar grade on the right, deep-dive label on the left */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Search className="h-5 w-5" />
          </div>
          <div>
            <SectionLabel icon={Search}>Deep SEO analysis</SectionLabel>
            <h3 className="mt-1.5 text-xl font-bold tracking-tight">
              SEO + Listings: the deepest pillar
            </h3>
            {pillar && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                Score {pillar.score}/100 · Grade {pillar.grade} · Domain authority, keywords, listings &amp; NAP
              </p>
            )}
            {(pillar as any)?.keysearchEnriched && (
              <Badge
                variant="secondary"
                className="mt-2 inline-flex gap-1 bg-accent/10 text-accent"
                data-testid="badge-keysearch-enriched"
              >
                <Sparkle className="h-3 w-3" />
                Keysearch enriched
              </Badge>
            )}
          </div>
        </div>
        {pillar && (
          <div
            className="flex h-14 w-14 items-center justify-center rounded-xl font-bold"
            style={{ background: gradeBg(pillar.grade), color: gradeColor(pillar.grade) }}
          >
            {pillar.grade}
          </div>
        )}
      </div>

      {/* Pillar narrative + S/G/R lists folded in */}
      {pillar && (
        <>
          <p className="mt-4 text-sm leading-relaxed">{pillar.summary}</p>
          <div className="mt-5 grid gap-4 md:grid-cols-3">
            <SubList tone="success" title="Strengths" items={pillar.strengths} />
            <SubList tone="danger" title="Gaps" items={pillar.gaps} />
            <SubList tone="primary" title="Recommendations" items={pillar.recommendations} />
          </div>
        </>
      )}

      {/* Authority metrics */}
      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric
          label="Domain authority"
          value={seo?.domainAuthority}
          max={100}
          highlight
        />
        <Metric label="Page authority" value={seo?.pageAuthority} max={100} />
        <Metric label="Backlinks" value={seo?.totalBacklinks} format="number" />
        <Metric label="Referring domains" value={seo?.referringDomains} format="number" />
      </div>

      {/* Ranking keywords */}
      {(seo?.rankingKeywords?.length ?? 0) > 0 && (
        <KeywordTable
          title="Currently ranking keywords"
          rows={seo!.rankingKeywords}
          showPosition
        />
      )}

      {/* Opportunity keywords */}
      {(seo?.opportunityKeywords?.length ?? 0) > 0 && (
        <KeywordTable
          title="Opportunity keywords"
          subtitle="High-value targets we can begin pursuing immediately"
          rows={seo!.opportunityKeywords}
          accent
        />
      )}

      {/* Listings */}
      {(seo?.listings?.length ?? 0) > 0 && <ListingsTable rows={seo!.listings} />}

      {/* NAP consistency */}
      {seo?.napConsistency && (
        <div className="mt-6 rounded-xl border border-card-border bg-secondary/30 p-5">
          <div className="flex items-baseline justify-between">
            <h4 className="text-sm font-bold">NAP consistency</h4>
            <span
              className="rounded-md px-2 py-0.5 text-xs font-semibold"
              style={{
                background: gradeBg(scoreToGrade(seo.napConsistency.score)),
                color: gradeColor(scoreToGrade(seo.napConsistency.score)),
              }}
            >
              {seo.napConsistency.score}/100
            </span>
          </div>
          {seo.napConsistency.notes && (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {seo.napConsistency.notes}
            </p>
          )}
          {(seo.napConsistency.nameVariants?.length ||
            seo.napConsistency.addressVariants?.length ||
            seo.napConsistency.phoneVariants?.length) && (
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
              {seo.napConsistency.nameVariants?.length ? (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Name variants
                  </dt>
                  <dd className="mt-1 space-y-0.5">
                    {seo.napConsistency.nameVariants.map((v, i) => (
                      <div key={i} className="font-mono text-xs">
                        {v}
                      </div>
                    ))}
                  </dd>
                </div>
              ) : null}
              {seo.napConsistency.addressVariants?.length ? (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Address variants
                  </dt>
                  <dd className="mt-1 space-y-0.5">
                    {seo.napConsistency.addressVariants.map((v, i) => (
                      <div key={i} className="font-mono text-xs">
                        {v}
                      </div>
                    ))}
                  </dd>
                </div>
              ) : null}
              {seo.napConsistency.phoneVariants?.length ? (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Phone variants
                  </dt>
                  <dd className="mt-1 space-y-0.5">
                    {seo.napConsistency.phoneVariants.map((v, i) => (
                      <div key={i} className="font-mono text-xs">
                        {v}
                      </div>
                    ))}
                  </dd>
                </div>
              ) : null}
            </dl>
          )}
        </div>
      )}

      {/* Keysearch Site Audit metrics */}
      {seo?.siteAudit && (
        <div
          className="mt-6 rounded-xl border border-card-border bg-secondary/30 p-5"
          data-testid="section-keysearch-site-audit"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h4 className="text-sm font-bold">Keysearch Site Audit</h4>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Technical SEO crawl from Keysearch
              </p>
            </div>
            {typeof seo.siteAudit.optimizationScore === "number" && (
              <div className="flex items-baseline gap-1">
                <span
                  className="text-3xl font-bold tracking-tight"
                  data-testid="text-optimization-score"
                >
                  {seo.siteAudit.optimizationScore}
                </span>
                <span className="text-sm text-muted-foreground">/100</span>
              </div>
            )}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {typeof seo.siteAudit.highIssues === "number" && (
              <div
                className="rounded-lg border border-card-border bg-background p-3"
                data-testid="metric-high-issues"
              >
                <div className="text-xs font-semibold uppercase tracking-wider text-red-600 dark:text-red-400">
                  High
                </div>
                <div className="mt-1 text-xl font-bold text-red-600 dark:text-red-400">
                  {seo.siteAudit.highIssues}
                </div>
              </div>
            )}
            {typeof seo.siteAudit.mediumIssues === "number" && (
              <div
                className="rounded-lg border border-card-border bg-background p-3"
                data-testid="metric-medium-issues"
              >
                <div className="text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                  Medium
                </div>
                <div className="mt-1 text-xl font-bold text-amber-600 dark:text-amber-400">
                  {seo.siteAudit.mediumIssues}
                </div>
              </div>
            )}
            {typeof seo.siteAudit.lowIssues === "number" && (
              <div
                className="rounded-lg border border-card-border bg-background p-3"
                data-testid="metric-low-issues"
              >
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Low
                </div>
                <div className="mt-1 text-xl font-bold text-muted-foreground">
                  {seo.siteAudit.lowIssues}
                </div>
              </div>
            )}
            {typeof seo.siteAudit.totalIssues === "number" && (
              <div
                className="rounded-lg border border-card-border bg-background p-3"
                data-testid="metric-total-issues"
              >
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Total Issues
                </div>
                <div className="mt-1 text-xl font-bold">
                  {seo.siteAudit.totalIssues}
                </div>
              </div>
            )}
            {typeof seo.siteAudit.pagesIndexed === "number" && (
              <div
                className="rounded-lg border border-card-border bg-background p-3"
                data-testid="metric-pages-indexed"
              >
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Pages Indexed
                </div>
                <div className="mt-1 text-xl font-bold">
                  {seo.siteAudit.pagesIndexed}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function Metric({
  label,
  value,
  max,
  format,
  highlight,
}: {
  label: string;
  value?: number;
  max?: number;
  format?: "number";
  highlight?: boolean;
}) {
  const display =
    value == null
      ? "N/A"
      : format === "number"
        ? formatNumber(value)
        : max
          ? `${Math.round(value)}/${max}`
          : value;
  return (
    <div
      className={`rounded-xl border p-4 ${
        highlight
          ? "border-accent/40 bg-accent/5"
          : "border-card-border bg-secondary/30"
      }`}
    >
      <div
        className={`text-xs font-medium uppercase tracking-wider ${
          highlight ? "text-accent" : "text-muted-foreground"
        }`}
      >
        {label}
      </div>
      <div className="mt-1 text-xl font-bold tabular-nums">{display}</div>
    </div>
  );
}

function KeywordTable({
  title,
  subtitle,
  rows,
  showPosition,
  accent,
}: {
  title: string;
  subtitle?: string;
  rows: KeywordRow[];
  showPosition?: boolean;
  accent?: boolean;
}) {
  // Show the "Volume Geo" column only when at least one row has a geo label.
  // (The DataForSEO-enriched opportunity keywords carry volumeGeo; the AI-
  // generated ranking keywords do not.)
  const showGeo = rows.some((r) => !!r.volumeGeo);
  return (
    <div className="mt-6">
      <div className="mb-2">
        <h4 className={`text-sm font-bold ${accent ? "text-accent" : ""}`}>{title}</h4>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="overflow-x-auto rounded-lg border border-card-border">
        <table className="w-full text-sm">
          <thead className="bg-secondary/50">
            <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 font-semibold">Keyword</th>
              {showPosition && <th className="px-3 py-2 font-semibold tabular-nums">Pos</th>}
              <th className="px-3 py-2 font-semibold tabular-nums">Volume</th>
              {showGeo && <th className="px-3 py-2 font-semibold">Volume Geo</th>}
              <th className="px-3 py-2 font-semibold tabular-nums">Difficulty</th>
              <th className="px-3 py-2 font-semibold tabular-nums">CPC</th>
              <th className="px-3 py-2 font-semibold">Intent</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r, i) => (
              <tr key={i} className="hover:bg-secondary/30">
                <td className="px-3 py-2 font-medium">{r.keyword}</td>
                {showPosition && <td className="px-3 py-2 tabular-nums">{r.position ?? "N/A"}</td>}
                <td className="px-3 py-2 tabular-nums">{formatNumber(r.volume)}</td>
                {showGeo && (
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.volumeGeo || "\u2014"}</td>
                )}
                <td className="px-3 py-2 tabular-nums">{r.difficulty != null ? Math.round(r.difficulty) : "N/A"}</td>
                <td className="px-3 py-2 tabular-nums">{formatCurrency(r.cpc)}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{r.intent || "N/A"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ListingsTable({ rows }: { rows: ListingRow[] }) {
  const statusIcon = (s: ListingRow["status"]) => {
    if (s === "Listed") return <Check className="h-3.5 w-3.5 text-accent" />;
    if (s === "Missing") return <X className="h-3.5 w-3.5 text-destructive" />;
    return <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />;
  };
  return (
    <div className="mt-6">
      <h4 className="mb-2 text-sm font-bold">Listings presence & accuracy</h4>
      <div className="overflow-x-auto rounded-lg border border-card-border">
        <table className="w-full text-sm">
          <thead className="bg-secondary/50">
            <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 font-semibold">Directory</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">NAP accurate</th>
              <th className="px-3 py-2 font-semibold">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="px-3 py-2 font-medium">{r.directory}</td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 text-sm">
                    {statusIcon(r.status)}
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2">
                  {r.napAccurate == null ? (
                    "N/A"
                  ) : r.napAccurate ? (
                    <Check className="h-4 w-4 text-accent" />
                  ) : (
                    <X className="h-4 w-4 text-destructive" />
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{r.notes || "N/A"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WebsitePerformanceSection({ wp }: { wp: ReportData["websitePerformance"] }) {
  if (!wp) return null;
  return (
    <Card className="border-card-border bg-gradient-to-br from-secondary/30 to-accent/5 p-6 md:p-8" data-testid="section-website-perf">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-4">
        <div>
          <SectionLabel icon={Globe}>Website performance</SectionLabel>
          <h3 className="mt-2 text-xl font-bold tracking-tight">A separate engagement</h3>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Website speed, mobile experience, and conversion architecture are their own conversation.
            Here is what we observed; let's schedule a follow-up to address it.
          </p>
        </div>
        <PerformanceStatusBadge
          scores={[wp.performanceScore, wp.mobileScore, wp.accessibilityScore, wp.seoScore]}
        />
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Performance" value={wp.performanceScore} max={100} />
        <Metric label="Mobile" value={wp.mobileScore} max={100} />
        <Metric label="Accessibility" value={wp.accessibilityScore} max={100} />
        <Metric label="SEO" value={wp.seoScore} max={100} />
      </div>

      {wp.coreWebVitals && (wp.coreWebVitals.lcp || wp.coreWebVitals.cls || wp.coreWebVitals.fid) && (
        <div className="mt-5 rounded-xl border border-card-border bg-card p-5">
          <div className="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Core Web Vitals, in plain English
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Vital vital={wp.coreWebVitals.lcp} />
            <Vital vital={wp.coreWebVitals.cls} />
            <Vital vital={wp.coreWebVitals.fid} />
          </div>
        </div>
      )}

      {(wp.conversionBlockers?.length || wp.securityNotes?.length) && (
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {wp.conversionBlockers?.length ? (
            <SubList tone="danger" title="Conversion blockers" items={wp.conversionBlockers} />
          ) : null}
          {wp.securityNotes?.length ? (
            <SubList tone="primary" title="Security notes" items={wp.securityNotes} />
          ) : null}
        </div>
      )}
    </Card>
  );
}

/**
 * Score-aware client-facing status badge for the Website Performance section.
 * Replaces the internal-language "Upsell opportunity" badge.
 *
 * Tiers (using the worst of the four website scores so the label reflects the
 * actual pain point, not an average that masks a critical sub-score):
 *   <= 39  -> Urgent need of improvement (red)
 *   40-59  -> Needs improvement         (amber)
 *   60-79  -> Can use improvement       (amber-light)
 *   80+    -> Performing well           (green)
 */
function PerformanceStatusBadge({ scores }: { scores: Array<number | undefined | null> }) {
  const valid = scores.filter((s): s is number => typeof s === "number" && !Number.isNaN(s));
  if (valid.length === 0) {
    return (
      <Badge className="border-0 bg-muted text-muted-foreground">Awaiting data</Badge>
    );
  }
  const worst = Math.min(...valid);
  let label: string;
  let className: string;
  if (worst <= 39) {
    label = "Urgent need of improvement";
    className = "border-0 bg-destructive text-destructive-foreground";
  } else if (worst <= 59) {
    label = "Needs improvement";
    className = "border-0 bg-amber-500 text-white";
  } else if (worst <= 79) {
    label = "Can use improvement";
    className = "border-0 bg-amber-200 text-amber-900";
  } else {
    label = "Performing well";
    className = "border-0 bg-accent text-accent-foreground";
  }
  return <Badge className={className}>{label}</Badge>;
}

function Vital({ vital }: { vital?: CoreWebVital }) {
  if (!vital) return null;
  const ratingTone =
    vital.rating === "Good"
      ? "text-accent bg-accent/10"
      : vital.rating === "Poor"
        ? "text-destructive bg-destructive/10"
        : "text-amber-700 bg-amber-500/10";
  return (
    <div className="rounded-lg border border-card-border bg-secondary/30 p-3">
      <div className="text-sm font-bold leading-snug">{vital.fullName}</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        {vital.value && (
          <span className="font-mono text-sm font-semibold tabular-nums">{vital.value}</span>
        )}
        {vital.rating && (
          <span
            className={`inline-block rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${ratingTone}`}
          >
            {vital.rating}
          </span>
        )}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{vital.plainEnglish}</p>
    </div>
  );
}

function ImmediateActionPlanSection({ plan }: { plan?: ImmediateActionPlan }) {
  if (!plan) return null;
  const buckets: { key: string; title: string; icon: React.ComponentType<{ className?: string }>; items?: ImmediateActionItem[] }[] = [
    { key: "quickWins", title: "Quick wins: start here", icon: Zap, items: plan.quickWins },
    { key: "aiAutomation", title: "AI Automation", icon: Bot, items: plan.aiAutomation },
    { key: "seoListings", title: "SEO + Listings", icon: Search, items: plan.seoListings },
    { key: "reputation", title: "Reputation", icon: Star, items: plan.reputation },
    { key: "socialMedia", title: "Social Media", icon: Users, items: plan.socialMedia },
  ].filter((b) => (b.items?.length ?? 0) > 0);

  return (
    <Card className="border-card-border p-6 md:p-8" data-testid="section-action-plan">
      <SectionLabel icon={Target}>Immediate action plan</SectionLabel>
      <h3 className="mt-2 text-xl font-bold tracking-tight">Where we begin</h3>
      {plan.summary && (
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">{plan.summary}</p>
      )}

      <div className="mt-6 grid gap-5 md:grid-cols-2">
        {buckets.map((b) => (
          <ActionBucket key={b.key} title={b.title} icon={b.icon} items={b.items!} />
        ))}
      </div>

      {(plan.expectedOutcomes?.length ?? 0) > 0 && (
        <div className="mt-6 rounded-xl border border-accent/30 bg-accent/5 p-5">
          <div className="mb-2 text-xs font-bold uppercase tracking-wider text-accent">
            Expected outcomes
          </div>
          <ul className="grid gap-1.5 text-sm md:grid-cols-2">
            {plan.expectedOutcomes.map((o, i) => (
              <li key={i} className="flex gap-2 leading-snug">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                <span>{o}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function ActionBucket({
  title,
  icon: Icon,
  items,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  items: ImmediateActionItem[];
}) {
  return (
    <div className="rounded-xl border border-card-border bg-secondary/20 p-5">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Icon className="h-3.5 w-3.5" />
        </div>
        <h4 className="text-sm font-bold">{title}</h4>
      </div>
      <ul className="space-y-3">
        {items.map((it, i) => (
          <li key={i} className="rounded-lg border border-card-border bg-card p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold leading-snug">{it.task}</p>
              <PriorityBadge priority={it.priority} />
            </div>
            {it.why && (
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{it.why}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PriorityBadge({ priority }: { priority: ImmediateActionItem["priority"] }) {
  const tone =
    priority === "Critical"
      ? "bg-destructive/10 text-destructive"
      : priority === "High"
        ? "bg-amber-500/15 text-amber-700"
        : "bg-secondary text-muted-foreground";
  return (
    <span className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${tone}`}>
      {priority}
    </span>
  );
}

function scoreToGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

/* -------------------- Structured text-only PDF -------------------- */
/**
 * Renders the report as a clean multi-page text PDF using ONLY jsPDF's
 * native text APIs — no html2canvas, no DOM rendering. This avoids the
 * cross-origin frame errors that html2canvas hits inside Perplexity's
 * sandboxed iframe ("Failed to read 'document' from 'Window'…"), and
 * produces a smaller, sharper PDF than a screenshot capture.
 */
function buildStructuredPdf(data: AuditDetail): jsPDF {
  const r = data.reportData!;
  const intake = data.intakeData ?? {};
  const pdf = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });
  const pageW = 210;
  const pageH = 297;
  const marginX = 16;
  const marginTop = 18;
  const marginBottom = 18;
  const usableW = pageW - marginX * 2;
  let y = marginTop;

  // Brand colors (mirror the on-screen design)
  const navy: [number, number, number] = [12, 36, 69];
  const accent: [number, number, number] = [44, 168, 109];
  const textDark: [number, number, number] = [20, 30, 48];
  const textMute: [number, number, number] = [105, 115, 130];
  const rule: [number, number, number] = [220, 226, 232];

  const ensureSpace = (needed: number) => {
    if (y + needed > pageH - marginBottom) {
      pdf.addPage();
      y = marginTop;
    }
  };

  const setText = (rgb: [number, number, number], size: number, bold = false) => {
    pdf.setTextColor(rgb[0], rgb[1], rgb[2]);
    pdf.setFontSize(size);
    pdf.setFont("helvetica", bold ? "bold" : "normal");
  };

  const writeWrapped = (text: string, lineH: number) => {
    const safe = (text || "").replace(/[\u2013\u2014]/g, ", ");
    const lines = pdf.splitTextToSize(safe, usableW) as string[];
    for (const line of lines) {
      ensureSpace(lineH);
      pdf.text(line, marginX, y);
      y += lineH;
    }
  };

  const sectionHeader = (label: string) => {
    ensureSpace(18);
    y += 4;
    setText(accent, 8, true);
    pdf.text(label.toUpperCase(), marginX, y, { charSpace: 0.6 } as any);
    y += 4;
    pdf.setDrawColor(rule[0], rule[1], rule[2]);
    pdf.setLineWidth(0.3);
    pdf.line(marginX, y, pageW - marginX, y);
    y += 6;
  };

  const h1 = (text: string) => {
    ensureSpace(12);
    setText(textDark, 18, true);
    writeWrapped(text, 8);
    y += 1;
  };

  const h2 = (text: string) => {
    ensureSpace(10);
    setText(textDark, 13, true);
    writeWrapped(text, 6);
    y += 1;
  };

  const h3 = (text: string) => {
    ensureSpace(8);
    setText(textDark, 11, true);
    writeWrapped(text, 5.5);
  };

  const body = (text: string) => {
    setText(textDark, 10);
    writeWrapped(text, 5);
    y += 1;
  };

  const muted = (text: string) => {
    setText(textMute, 9);
    writeWrapped(text, 4.6);
  };

  const bullets = (items: string[] | undefined) => {
    if (!items || items.length === 0) return;
    setText(textDark, 10);
    for (const item of items) {
      const safe = (item || "").replace(/[\u2013\u2014]/g, ", ");
      const lines = pdf.splitTextToSize(safe, usableW - 6) as string[];
      ensureSpace(5.2);
      pdf.setFillColor(accent[0], accent[1], accent[2]);
      pdf.circle(marginX + 1.5, y - 1.2, 0.8, "F");
      pdf.text(lines[0], marginX + 5, y);
      y += 5;
      for (let i = 1; i < lines.length; i++) {
        ensureSpace(5);
        pdf.text(lines[i], marginX + 5, y);
        y += 5;
      }
    }
    y += 1;
  };

  /* ---- Cover page ---- */
  pdf.setFillColor(navy[0], navy[1], navy[2]);
  pdf.rect(0, 0, pageW, 95, "F");

  setText(accent, 8, true);
  pdf.setTextColor(accent[0], accent[1], accent[2]);
  pdf.text("DIGITAL PRESENCE AUDIT", marginX, 32);

  setText([255, 255, 255], 26, true);
  pdf.text("The Four-Pillar Report", marginX, 46);

  setText([220, 226, 240], 11);
  pdf.text(
    "An executive view of how this business shows up across AI assistants,",
    marginX,
    58
  );
  pdf.text("search, reputation, and social, with a clear immediate plan of action.", marginX, 64);

  setText([200, 210, 226], 8, true);
  pdf.text("SMB SOLUTIONS  -  INTERNAL TOOL", pageW - marginX, 32, { align: "right" });

  // Below-fold: client identity
  y = 110;
  setText(accent, 8, true);
  pdf.text("AUDIT PREPARED FOR", marginX, y);
  y += 8;
  setText(textDark, 22, true);
  writeWrapped(data.clientName || "", 8);
  y += 2;

  setText(textMute, 10);
  if (data.clientWebsite) writeWrapped(data.clientWebsite, 5);
  if (intake.address || data.location) writeWrapped(intake.address || data.location || "", 5);
  if (intake.phone) writeWrapped(intake.phone, 5);
  y += 2;
  if (data.industry)
    muted(`${data.industry}  -  ${formatDate(data.createdAt)}`);
  else muted(formatDate(data.createdAt));

  // Overall grade chip
  y += 4;
  if (data.overallGrade && typeof data.overallScore === "number") {
    const chipW = 56;
    const chipH = 22;
    const chipX = pageW - marginX - chipW;
    const chipY = y;
    pdf.setFillColor(247, 230, 230);
    pdf.roundedRect(chipX, chipY, chipW, chipH, 3, 3, "F");
    setText([192, 50, 50], 22, true);
    pdf.text(data.overallGrade, chipX + chipW / 2, chipY + 11, { align: "center" });
    setText([130, 60, 60], 8, true);
    pdf.text("OVERALL", chipX + chipW / 2, chipY + 16, { align: "center" });
    pdf.text(`${data.overallScore}/100`, chipX + chipW / 2, chipY + 20, { align: "center" });
    y += chipH + 6;
  }

  /* ---- Executive Summary ---- */
  pdf.addPage();
  y = marginTop;
  sectionHeader("Executive Summary");
  body(r.executiveSummary.diagnosis);
  if (r.executiveSummary.topWins?.length) {
    h3("Top wins");
    bullets(r.executiveSummary.topWins);
  }
  if (r.executiveSummary.topRisks?.length) {
    h3("Top risks");
    bullets(r.executiveSummary.topRisks);
  }

  /* ---- The Four Pillars (overview) ---- */
  sectionHeader("Four-Pillar Overview");
  const pillarList: { name: string; data: PillarReport }[] = [
    { name: "AI Automation", data: r.pillars.aiAutomation },
    { name: "SEO + Listings", data: r.pillars.seoListings },
    { name: "Reputation", data: r.pillars.reputation },
    { name: "Social Media", data: r.pillars.socialMedia },
  ];
  for (const p of pillarList) {
    h3(`${p.name}  -  ${p.data.grade}  (${p.data.score}/100)`);
    body(p.data.summary);
  }

  /* ---- Pillar deep dives (AI, Reputation, Social, then SEO last) ---- */
  const detailOrder: { name: string; data: PillarReport; ai?: AiAutomationPillar }[] = [
    { name: "AI Automation", data: r.pillars.aiAutomation, ai: r.pillars.aiAutomation },
    { name: "Reputation", data: r.pillars.reputation },
    { name: "Social Media", data: r.pillars.socialMedia },
  ];
  for (const p of detailOrder) {
    pdf.addPage();
    y = marginTop;
    sectionHeader(p.name);
    h2(`Score ${p.data.score}/100  -  Grade ${p.data.grade}`);
    body(p.data.summary);
    if (p.ai?.platforms?.length) {
      h3("AI platform presence");
      const platformLines = p.ai.platforms.map(
        (pl) => `${pl.platform}: ${pl.present ? "Present" : "Missing"}${pl.notes ? " - " + pl.notes : ""}`
      );
      bullets(platformLines);
    }
    if (p.data.strengths?.length) {
      h3("Strengths");
      bullets(p.data.strengths);
    }
    if (p.data.gaps?.length) {
      h3("Gaps");
      bullets(p.data.gaps);
    }
    if (p.data.recommendations?.length) {
      h3("Recommendations");
      bullets(p.data.recommendations);
    }
  }

  /* ---- Deep SEO (last) ---- */
  pdf.addPage();
  y = marginTop;
  sectionHeader("Deep SEO + Listings");
  h2(`Score ${r.pillars.seoListings.score}/100  -  Grade ${r.pillars.seoListings.grade}`);
  body(r.pillars.seoListings.summary);

  if (r.seoDeep) {
    h3("Authority signals");
    const lines: string[] = [];
    if (typeof r.seoDeep.domainAuthority === "number")
      lines.push(`Domain Authority: ${r.seoDeep.domainAuthority}`);
    if (typeof r.seoDeep.pageAuthority === "number")
      lines.push(`Page Authority: ${r.seoDeep.pageAuthority}`);
    if (typeof r.seoDeep.totalBacklinks === "number")
      lines.push(`Total backlinks: ${formatNumber(r.seoDeep.totalBacklinks)}`);
    if (typeof r.seoDeep.referringDomains === "number")
      lines.push(`Referring domains: ${formatNumber(r.seoDeep.referringDomains)}`);
    if (lines.length) bullets(lines);

    if (r.seoDeep.napConsistency) {
      h3(`NAP consistency  -  ${r.seoDeep.napConsistency.score}/100`);
      if (r.seoDeep.napConsistency.notes) body(r.seoDeep.napConsistency.notes);
    }

    if (r.seoDeep.siteAudit) {
      const sa = r.seoDeep.siteAudit;
      const heading =
        typeof sa.optimizationScore === "number"
          ? `Keysearch Site Audit  -  ${sa.optimizationScore}/100 optimization score`
          : "Keysearch Site Audit";
      h3(heading);
      const saLines: string[] = [];
      if (typeof sa.highIssues === "number")
        saLines.push(`High issues: ${sa.highIssues}`);
      if (typeof sa.mediumIssues === "number")
        saLines.push(`Medium issues: ${sa.mediumIssues}`);
      if (typeof sa.lowIssues === "number")
        saLines.push(`Low issues: ${sa.lowIssues}`);
      if (typeof sa.totalIssues === "number")
        saLines.push(`Total issues: ${sa.totalIssues}`);
      if (typeof sa.pagesIndexed === "number")
        saLines.push(`Pages indexed: ${sa.pagesIndexed}`);
      if (saLines.length) bullets(saLines);
    }

    if (r.seoDeep.rankingKeywords?.length) {
      h3("Top ranking keywords");
      bullets(
        r.seoDeep.rankingKeywords
          .slice(0, 12)
          .map((k) => `${k.keyword}${k.position ? ` (#${k.position})` : ""}${k.volume ? `, ${formatNumber(k.volume)} vol` : ""}`)
      );
    }
    if (r.seoDeep.opportunityKeywords?.length) {
      h3("Opportunity keywords");
      bullets(
        r.seoDeep.opportunityKeywords
          .slice(0, 12)
          .map((k) => `${k.keyword}${k.volume ? `, ${formatNumber(k.volume)} vol` : ""}${k.difficulty ? `, KD ${k.difficulty}` : ""}`)
      );
    }
    if (r.seoDeep.listings?.length) {
      h3("Directory listings");
      bullets(
        r.seoDeep.listings
          .slice(0, 20)
          .map((l) => `${l.directory}: ${l.status}${l.notes ? " - " + l.notes : ""}`)
      );
    }
  }

  if (p_strengths(r.pillars.seoListings)) {
    h3("Strengths");
    bullets(r.pillars.seoListings.strengths);
  }
  if (r.pillars.seoListings.gaps?.length) {
    h3("Gaps");
    bullets(r.pillars.seoListings.gaps);
  }
  if (r.pillars.seoListings.recommendations?.length) {
    h3("Recommendations");
    bullets(r.pillars.seoListings.recommendations);
  }

  /* ---- Website performance ---- */
  if (r.websitePerformance) {
    pdf.addPage();
    y = marginTop;
    sectionHeader("Website Performance");
    const wp = r.websitePerformance;
    const scoreLines: string[] = [];
    if (typeof wp.performanceScore === "number")
      scoreLines.push(`Performance: ${wp.performanceScore}/100`);
    if (typeof wp.mobileScore === "number") scoreLines.push(`Mobile: ${wp.mobileScore}/100`);
    if (typeof wp.accessibilityScore === "number")
      scoreLines.push(`Accessibility: ${wp.accessibilityScore}/100`);
    if (typeof wp.seoScore === "number") scoreLines.push(`SEO: ${wp.seoScore}/100`);
    if (scoreLines.length) bullets(scoreLines);

    if (wp.coreWebVitals) {
      h3("Core Web Vitals");
      const cwvLines: string[] = [];
      const v = wp.coreWebVitals;
      if (v.lcp)
        cwvLines.push(
          `${v.lcp.fullName} (${v.lcp.value || "n/a"}, ${v.lcp.rating || ""}): ${v.lcp.plainEnglish}`
        );
      if (v.cls)
        cwvLines.push(
          `${v.cls.fullName} (${v.cls.value || "n/a"}, ${v.cls.rating || ""}): ${v.cls.plainEnglish}`
        );
      if (v.fid)
        cwvLines.push(
          `${v.fid.fullName} (${v.fid.value || "n/a"}, ${v.fid.rating || ""}): ${v.fid.plainEnglish}`
        );
      if (cwvLines.length) bullets(cwvLines);
    }
    if (wp.conversionBlockers?.length) {
      h3("Conversion blockers");
      bullets(wp.conversionBlockers);
    }
    if (wp.securityNotes?.length) {
      h3("Security notes");
      bullets(wp.securityNotes);
    }
  }

  /* ---- Immediate action plan ---- */
  if (r.immediateActionPlan) {
    pdf.addPage();
    y = marginTop;
    sectionHeader("Immediate Action Plan");
    body(r.immediateActionPlan.summary);
    const planSections: { title: string; items?: ImmediateActionItem[] }[] = [
      { title: "AI Automation", items: r.immediateActionPlan.aiAutomation },
      { title: "SEO + Listings", items: r.immediateActionPlan.seoListings },
      { title: "Reputation", items: r.immediateActionPlan.reputation },
      { title: "Social Media", items: r.immediateActionPlan.socialMedia },
      { title: "Quick Wins", items: r.immediateActionPlan.quickWins },
    ];
    for (const s of planSections) {
      if (!s.items || s.items.length === 0) continue;
      h3(s.title);
      bullets(s.items.map((it) => `[${it.priority}] ${it.task}  -  ${it.why}`));
    }
    if (r.immediateActionPlan.expectedOutcomes?.length) {
      h3("Expected outcomes");
      bullets(r.immediateActionPlan.expectedOutcomes);
    }
  }

  /* ---- Footer page numbers ---- */
  const pageCount = pdf.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    pdf.setPage(i);
    setText(textMute, 8);
    pdf.text(
      `${data.clientName || ""}  -  Digital Presence Audit  -  Page ${i} of ${pageCount}`,
      pageW / 2,
      pageH - 8,
      { align: "center" }
    );
  }

  return pdf;
}

function p_strengths(p: PillarReport | undefined): boolean {
  return !!(p?.strengths && p.strengths.length > 0);
}

/* -------------------- Edit business info (NAP) -------------------- */

function EditBusinessInfoButton({ audit }: { audit: AuditDetail }) {
  const [open, setOpen] = useState(false);
  const intake = audit.intakeData ?? {};
  const [form, setForm] = useState({
    clientName: audit.clientName || "",
    clientWebsite: audit.clientWebsite || "",
    address: intake.address || "",
    phone: intake.phone || "",
    location: audit.location || intake.location || "",
    industry: audit.industry || intake.industry || "",
  });
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async (payload: typeof form) => {
      const res = await apiRequest("PATCH", `/api/audits/${audit.id}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/audits", audit.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/audits"] });
      toast({ title: "Business info updated", description: "NAP saved to this audit." });
      setOpen(false);
    },
    onError: (err: any) => {
      toast({
        title: "Could not update",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="no-print h-7 gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
        data-testid="button-edit-business-info"
      >
        <Pencil className="h-3 w-3" />
        Edit
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit business info</DialogTitle>
            <DialogDescription>
              The Name, Address, and Phone (NAP) shown on the audit cover. Pulled automatically
              from the uploaded intake or order form when available, and editable here at any time.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="edit-client-name">Business name</Label>
              <Input
                id="edit-client-name"
                value={form.clientName}
                onChange={(e) => setForm({ ...form, clientName: e.target.value })}
                data-testid="input-edit-client-name"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-website">Website</Label>
              <Input
                id="edit-website"
                value={form.clientWebsite}
                onChange={(e) => setForm({ ...form, clientWebsite: e.target.value })}
                data-testid="input-edit-website"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-address">Full address</Label>
              <Input
                id="edit-address"
                placeholder="Street, suite, city, state, ZIP"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                data-testid="input-edit-address"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-phone">Phone</Label>
              <Input
                id="edit-phone"
                placeholder="e.g. 469-525-8123"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                data-testid="input-edit-phone"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="edit-industry">Industry</Label>
                <Input
                  id="edit-industry"
                  value={form.industry}
                  onChange={(e) => setForm({ ...form, industry: e.target.value })}
                  data-testid="input-edit-industry"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="edit-location">City, State</Label>
                <Input
                  id="edit-location"
                  value={form.location}
                  onChange={(e) => setForm({ ...form, location: e.target.value })}
                  data-testid="input-edit-location"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              data-testid="button-cancel-edit"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => mutation.mutate(form)}
              disabled={mutation.isPending}
              data-testid="button-save-edit"
            >
              {mutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* -------------------- Keysearch Pull Button -------------------- */
function KeysearchPullButton({ auditId }: { auditId: string }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleStart() {
    if (!url.trim()) return;
    setSubmitting(true);
    setErrorMsg(null);
    setDoneMsg(null);
    try {
      const res = await apiRequest("POST", `/api/audits/${auditId}/keysearch-pull`, {
        keysearchUrl: url.trim(),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.message || "Pull failed");
      }
      setDoneMsg("Done. Refresh to see updated data.");
      setTimeout(() => {
        setOpen(false);
        setDoneMsg(null);
        setUrl("");
      }, 2500);
    } catch (e: any) {
      setErrorMsg(e?.message || "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    if (submitting) return;
    setOpen(false);
    setUrl("");
    setErrorMsg(null);
    setDoneMsg(null);
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="no-print h-7 gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
        data-testid="button-keysearch-pull"
      >
        <Database className="h-3 w-3" />
        Pull Keysearch Data
      </Button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : handleCancel())}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Pull Keysearch data</DialogTitle>
            <DialogDescription>
              Paste the URL of your completed Keysearch audit. The assistant will read the
              page and merge domain authority, backlinks, and ranking keywords into this report.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="keysearch-url">Keysearch Audit URL</Label>
              <Input
                id="keysearch-url"
                placeholder="https://www.keysearch.co/..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={submitting}
                data-testid="input-keysearch-url"
              />
            </div>
            {submitting && (
              <div className="flex items-center gap-2 rounded-md border border-card-border bg-secondary/40 p-3 text-sm">
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
                <span>Pulling Keysearch data... this can take up to 2 minutes</span>
              </div>
            )}
            {doneMsg && (
              <div className="rounded-md border border-accent/40 bg-accent/10 p-3 text-sm text-accent">
                {doneMsg}
              </div>
            )}
            {errorMsg && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {errorMsg}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={submitting}
              data-testid="button-keysearch-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleStart}
              disabled={submitting || !url.trim()}
              data-testid="button-keysearch-start"
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  Pulling...
                </>
              ) : (
                "Start Pull"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* -------------------- Activity Timeline -------------------- */

const EVENT_LABELS: Record<AuditEventType, string> = {
  created: "Audit created",
  completed: "Report generated",
  failed: "Generation failed",
  rerun: "Audit re-run",
  manus_uploaded: "Manus PDF uploaded",
  script_generated: "ElevenLabs script generated",
  script_edited: "Script edited",
  delivered: "Marked as delivered",
  marked_ready: "Marked as ready",
};

function eventIcon(type: AuditEventType) {
  switch (type) {
    case "created":
      return <Sparkle className="h-3.5 w-3.5" />;
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5 text-accent" />;
    case "failed":
      return <XCircle className="h-3.5 w-3.5 text-destructive" />;
    case "rerun":
      return <RefreshCw className="h-3.5 w-3.5" />;
    case "manus_uploaded":
      return <Upload className="h-3.5 w-3.5" />;
    case "script_generated":
      return <Sparkles className="h-3.5 w-3.5 text-accent" />;
    case "script_edited":
      return <Pencil className="h-3.5 w-3.5" />;
    case "delivered":
      return <Send className="h-3.5 w-3.5 text-accent" />;
    case "marked_ready":
      return <Check className="h-3.5 w-3.5" />;
    default:
      return <Clock className="h-3.5 w-3.5" />;
  }
}

function formatEventTime(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatEventMeta(ev: AuditEvent): string {
  const m = ev.meta as Record<string, unknown> | undefined;
  if (!m) return "";
  if (ev.type === "completed" && (m.grade || m.score != null)) {
    const parts: string[] = [];
    if (m.grade) parts.push(`Grade ${m.grade}`);
    if (m.score != null) parts.push(`${m.score}/100`);
    return parts.join(" \u00b7 ");
  }
  if (ev.type === "failed" && m.error) {
    const e = String(m.error);
    return e.length > 80 ? e.slice(0, 77) + "..." : e;
  }
  if (ev.type === "manus_uploaded" && m.sizeBytes != null) {
    const kb = Math.round(Number(m.sizeBytes) / 1024);
    return `${kb} KB${m.format ? " \u00b7 " + m.format : ""}`;
  }
  if (ev.type === "script_generated") {
    const parts: string[] = [];
    if (m.regenerated) parts.push("regenerated");
    if (m.chars != null) parts.push(`${Number(m.chars).toLocaleString()} chars`);
    return parts.join(" \u00b7 ");
  }
  if (ev.type === "script_edited" && m.chars != null) {
    return `${Number(m.chars).toLocaleString()} chars`;
  }
  return "";
}

function ActivityTimeline({
  events,
  createdAt,
}: {
  events: AuditEvent[];
  createdAt: number;
}) {
  // If the eventLog is empty (audit predates the event-log feature), synthesize
  // a single "created" event from createdAt so the section never looks broken.
  const synthesized: AuditEvent[] =
    events.length === 0 ? [{ type: "created", at: createdAt }] : events;

  // Newest first.
  const sorted = [...synthesized].sort((a, b) => b.at - a.at);

  return (
    <Card
      className="no-print border-card-border p-6 md:p-8"
      data-testid="section-activity-timeline"
    >
      <SectionLabel icon={Clock}>Activity</SectionLabel>
      <h3 className="mt-2 text-lg font-bold tracking-tight">Audit Timeline</h3>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Every meaningful event on this audit with a timestamp for reference.
      </p>

      <ScrollArea className="mt-5 max-h-96 pr-3">
        <ol className="relative space-y-3 border-l border-card-border pl-5">
          {sorted.map((ev, i) => (
            <li
              key={`${ev.at}-${i}`}
              className="relative"
              data-testid={`event-${ev.type}`}
            >
              <span className="absolute -left-[1.4rem] top-1 flex h-5 w-5 items-center justify-center rounded-full border border-card-border bg-background">
                {eventIcon(ev.type)}
              </span>
              <div className="flex flex-col gap-0.5">
                <div className="text-sm font-medium">
                  {EVENT_LABELS[ev.type] || ev.type}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatEventTime(ev.at)}
                  {formatEventMeta(ev) && (
                    <span className="ml-2 italic">{formatEventMeta(ev)}</span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </ScrollArea>
    </Card>
  );
}

/* -------------------- Final Manus Deliverable -------------------- */
function FinalDeliverableSection({
  auditId,
  uploadedAt,
}: {
  auditId: string;
  uploadedAt: number | null;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Script editor state. The flow: click "View & Edit Script" -> modal opens,
  // fetches /elevenlabs-script?format=json (returns saved edits if any, else
  // freshly generates). User edits in textarea -> Save persists to the audit
  // record. Download streams the same content as .txt. Regenerate clears the
  // saved edits and rebuilds from the Manus PDF (with a confirmation).
  const [scriptOpen, setScriptOpen] = useState(false);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [scriptSaving, setScriptSaving] = useState(false);
  const [scriptText, setScriptText] = useState("");
  const [scriptIsEdited, setScriptIsEdited] = useState(false);
  const [scriptDirty, setScriptDirty] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [scriptFilename, setScriptFilename] = useState("elevenlabs-dj2-script.txt");
  const { toast } = useToast();

  const hasUploaded = !!uploadedAt;
  const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
  const downloadUrl = `${API_BASE}/api/audits/${auditId}/manus-pdf`;
  const scriptUrl = `${API_BASE}/api/audits/${auditId}/elevenlabs-script`;

  async function loadScript(opts: { regenerate?: boolean } = {}) {
    setScriptLoading(true);
    setScriptError(null);
    try {
      const url = opts.regenerate
        ? `${scriptUrl}?format=json&regenerate=1`
        : `${scriptUrl}?format=json`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        let msg = `Failed (HTTP ${res.status})`;
        try {
          const j = await res.json();
          if (j?.message) msg = j.message;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const json = await res.json();
      setScriptText(json.script || "");
      setScriptIsEdited(!!json.edited);
      setScriptFilename(json.filename || "elevenlabs-dj2-script.txt");
      setScriptDirty(false);
      if (opts.regenerate) {
        // Invalidate the audit query so the event log timeline picks up the
        // new script_generated event.
        queryClient.invalidateQueries({ queryKey: ["/api/audits", auditId] });
      }
    } catch (e: any) {
      setScriptError(e?.message || "Could not load script.");
    } finally {
      setScriptLoading(false);
    }
  }

  async function openScriptEditor() {
    setScriptOpen(true);
    if (!scriptText) {
      await loadScript();
    }
  }

  async function saveScript() {
    setScriptSaving(true);
    setScriptError(null);
    try {
      const res = await fetch(scriptUrl, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: scriptText }),
      });
      if (!res.ok) {
        let msg = `Save failed (HTTP ${res.status})`;
        try {
          const j = await res.json();
          if (j?.message) msg = j.message;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      setScriptIsEdited(true);
      setScriptDirty(false);
      toast({ title: "Script saved", description: "Your edits are stored on this audit." });
      queryClient.invalidateQueries({ queryKey: ["/api/audits", auditId] });
    } catch (e: any) {
      setScriptError(e?.message || "Save failed.");
    } finally {
      setScriptSaving(false);
    }
  }

  function downloadScriptFromText() {
    const blob = new Blob([scriptText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = scriptFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handleSubmit() {
    if (!file) {
      setErrorMsg("Please choose a PDF first.");
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const fd = new FormData();
      fd.append("manusPdf", file);
      const res = await fetch(`${API_BASE}/api/audits/${auditId}/final-deliverable`, {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.message || "Upload failed");
      }
      setFile(null);
      queryClient.invalidateQueries({ queryKey: ["/api/audits", auditId] });
    } catch (e: any) {
      setErrorMsg(e?.message || "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card
      className="no-print border-card-border p-6 md:p-8"
      data-testid="section-final-deliverable"
    >
      <SectionLabel icon={Upload}>Final Client Deliverable</SectionLabel>
      <h3 className="mt-2 text-lg font-bold tracking-tight">Manus PDF</h3>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Upload the simplified PDF that Manus produced from this audit. We just store it
        here so you can grab the download link any time.
      </p>

      <div className="mt-5 grid gap-5">
        {hasUploaded && (
          <div
            className="flex flex-col gap-3 rounded-lg border border-accent/40 bg-accent/10 p-4"
            data-testid="manus-pdf-stored"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <FileDown className="h-5 w-5 shrink-0 text-accent" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">Final PDF stored</div>
                  <div className="text-xs text-muted-foreground">
                    Uploaded {formatDate(uploadedAt!)}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  asChild
                  variant="outline"
                  data-testid="button-download-manus-pdf"
                >
                  <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
                    <FileDown className="mr-1.5 h-4 w-4" />
                    Download PDF
                  </a>
                </Button>
                <Button
                  type="button"
                  onClick={openScriptEditor}
                  disabled={scriptLoading}
                  className="bg-accent text-accent-foreground hover:bg-accent/90"
                  data-testid="button-view-elevenlabs-script"
                >
                  {scriptLoading && !scriptOpen ? (
                    <>
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Eye className="mr-1.5 h-4 w-4" />
                      View & Edit Script
                    </>
                  )}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              The ElevenLabs script is the DJ #2 narration written from this PDF.
              Open it to preview, make edits, save, and download. First generation
              takes about 20 seconds.
            </p>
            {scriptError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                {scriptError}
              </div>
            )}
          </div>
        )}

        <div className="grid gap-2">
          <Label>{hasUploaded ? "Replace PDF" : "Upload Manus simplified PDF"}</Label>
          {file ? (
            <div
              className="flex items-center gap-3 rounded-lg border border-card-border bg-secondary/40 p-3"
              data-testid="manus-pdf-file"
            >
              <FileDown className="h-5 w-5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{file.name}</div>
                <div className="text-xs text-muted-foreground">
                  {(file.size / 1024).toFixed(0)} KB
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setFile(null)}
                disabled={submitting}
                data-testid="manus-pdf-remove"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="hover-elevate flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-secondary/30 px-4 py-6 text-sm"
              data-testid="manus-pdf-dropzone"
            >
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-sm font-medium">
                {hasUploaded ? "Click to upload a new PDF" : "Click to upload PDF"}
              </span>
              <span className="text-xs text-muted-foreground">Up to 50 MB</span>
            </button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>

        {errorMsg && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {errorMsg}
          </div>
        )}

        {file && (
          <div className="flex justify-end">
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="bg-accent text-accent-foreground hover:bg-accent/90"
              data-testid="button-save-manus-pdf"
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  Uploading...
                </>
              ) : hasUploaded ? (
                "Replace stored PDF"
              ) : (
                "Save PDF"
              )}
            </Button>
          </div>
        )}
      </div>

      {/* -------- ElevenLabs script viewer + editor -------- */}
      <Dialog
        open={scriptOpen}
        onOpenChange={(o) => {
          // Block closing if there are unsaved edits.
          if (!o && scriptDirty) {
            const ok = window.confirm("You have unsaved edits. Close anyway?");
            if (!ok) return;
          }
          setScriptOpen(o);
        }}
      >
        <DialogContent
          className="max-w-4xl"
          data-testid="dialog-elevenlabs-script"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkle className="h-5 w-5 text-accent" />
              ElevenLabs DJ #2 Script
              {scriptIsEdited && (
                <Badge variant="secondary" className="ml-2 text-xs">
                  Edited
                </Badge>
              )}
              {scriptDirty && (
                <Badge variant="outline" className="ml-1 border-amber-500 text-xs text-amber-600">
                  Unsaved changes
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              Preview, edit, and download the narration script. Edits are saved on
              this audit and will be served the next time you open or download.
              Regenerate to rebuild from the Manus PDF.
            </DialogDescription>
          </DialogHeader>

          {scriptLoading ? (
            <div className="flex h-96 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              Generating script… this takes about 20 seconds.
            </div>
          ) : (
            <Textarea
              value={scriptText}
              onChange={(e) => {
                setScriptText(e.target.value);
                setScriptDirty(true);
              }}
              className="h-96 max-h-[60vh] min-h-[24rem] font-mono text-xs"
              spellCheck={false}
              data-testid="textarea-elevenlabs-script"
            />
          )}

          {scriptError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {scriptError}
            </div>
          )}

          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmRegenerate(true)}
                disabled={scriptLoading || scriptSaving}
                data-testid="button-regenerate-script"
              >
                <RotateCw className="mr-1.5 h-4 w-4" />
                Regenerate
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={downloadScriptFromText}
                disabled={!scriptText || scriptLoading}
                data-testid="button-download-script"
              >
                <FileDown className="mr-1.5 h-4 w-4" />
                Download .txt
              </Button>
              <Button
                type="button"
                onClick={saveScript}
                disabled={!scriptDirty || scriptSaving || scriptLoading}
                className="bg-accent text-accent-foreground hover:bg-accent/90"
                data-testid="button-save-script"
              >
                {scriptSaving ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <Save className="mr-1.5 h-4 w-4" />
                    Save
                  </>
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation: Regenerate destroys saved edits */}
      <Dialog open={confirmRegenerate} onOpenChange={setConfirmRegenerate}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Regenerate the script?</DialogTitle>
            <DialogDescription>
              This rebuilds the narration from the Manus PDF and report data.
              {scriptIsEdited || scriptDirty
                ? " Your saved edits will be replaced."
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmRegenerate(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={async () => {
                setConfirmRegenerate(false);
                await loadScript({ regenerate: true });
              }}
              className="bg-accent text-accent-foreground hover:bg-accent/90"
            >
              <RotateCw className="mr-1.5 h-4 w-4" />
              Regenerate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/* -------------------- Markdown outline export -------------------- */
function buildMarkdownOutline(data: AuditDetail): string {
  const r = data.reportData!;
  const intake = data.intakeData ?? {};
  const lines: string[] = [];

  const safe = (s: string | null | undefined) => (s || "").replace(/[\u2013\u2014]/g, ", ");

  lines.push(`# ${data.clientName || "Audit"}`);
  lines.push("");
  lines.push(`**Digital Presence Audit** — Overall grade **${data.overallGrade ?? "N/A"}**` +
    (data.overallScore != null ? ` (${data.overallScore}/100)` : ""));
  lines.push("");

  // NAP table
  lines.push("## Business Information (NAP)");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Name | ${data.clientName || "N/A"} |`);
  lines.push(`| Address | ${intake.address || data.location || "N/A"} |`);
  lines.push(`| Phone | ${intake.phone || "N/A"} |`);
  lines.push(`| Website | ${data.clientWebsite || "N/A"} |`);
  if (data.industry) lines.push(`| Industry | ${data.industry} |`);
  lines.push("");

  // Executive summary
  lines.push("## Executive Summary");
  lines.push("");
  lines.push(safe(r.executiveSummary?.diagnosis));
  lines.push("");
  if (r.executiveSummary?.topWins?.length) {
    lines.push("### Top Wins");
    for (const w of r.executiveSummary.topWins) lines.push(`- ${safe(w)}`);
    lines.push("");
  }
  if (r.executiveSummary?.topRisks?.length) {
    lines.push("### Top Risks");
    for (const w of r.executiveSummary.topRisks) lines.push(`- ${safe(w)}`);
    lines.push("");
  }

  // Pillars
  const pillarOrder: { key: keyof ReportData["pillars"]; label: string }[] = [
    { key: "aiAutomation", label: "AI Automation" },
    { key: "reputation", label: "Reputation" },
    { key: "socialMedia", label: "Social Media" },
    { key: "seoListings", label: "SEO + Listings" },
  ];
  for (const { key, label } of pillarOrder) {
    const p = r.pillars?.[key] as PillarReport | undefined;
    if (!p) continue;
    lines.push(`## ${label}`);
    lines.push("");
    lines.push(`**Grade:** ${p.grade}  •  **Score:** ${p.score}/100`);
    lines.push("");
    if (p.summary) {
      lines.push(safe(p.summary));
      lines.push("");
    }
    if (p.strengths?.length) {
      lines.push("### Strengths");
      for (const s of p.strengths) lines.push(`- ${safe(s)}`);
      lines.push("");
    }
    if (p.gaps?.length) {
      lines.push("### Gaps");
      for (const s of p.gaps) lines.push(`- ${safe(s)}`);
      lines.push("");
    }
    if (p.recommendations?.length) {
      lines.push("### Recommendations");
      for (const s of p.recommendations) lines.push(`- ${safe(s)}`);
      lines.push("");
    }
    // AI platforms
    if (key === "aiAutomation") {
      const ai = p as AiAutomationPillar;
      if (ai.platforms?.length) {
        lines.push("### AI Assistants");
        lines.push("");
        lines.push("| Platform | Surfacing | Notes |");
        lines.push("| --- | --- | --- |");
        for (const pl of ai.platforms) {
          lines.push(
            `| ${pl.platform} | ${pl.present ? "Yes" : "No"} | ${safe(pl.notes || "")} |`
          );
        }
        lines.push("");
      }
    }
  }

  // Deep SEO
  if (r.seoDeep) {
    lines.push("## Deep SEO Metrics");
    lines.push("");
    lines.push(`- Domain authority: ${r.seoDeep.domainAuthority ?? "N/A"}`);
    lines.push(`- Page authority: ${r.seoDeep.pageAuthority ?? "N/A"}`);
    lines.push(`- Total backlinks: ${r.seoDeep.totalBacklinks ?? "N/A"}`);
    lines.push(`- Referring domains: ${r.seoDeep.referringDomains ?? "N/A"}`);
    if (r.seoDeep.napConsistency) {
      lines.push(`- NAP consistency: ${r.seoDeep.napConsistency.score}/100`);
    }
    lines.push("");

    if (r.seoDeep.siteAudit) {
      const sa = r.seoDeep.siteAudit;
      lines.push("### Keysearch Site Audit");
      lines.push("");
      if (typeof sa.optimizationScore === "number")
        lines.push(`- Optimization score: ${sa.optimizationScore}/100`);
      if (typeof sa.highIssues === "number")
        lines.push(`- High issues: ${sa.highIssues}`);
      if (typeof sa.mediumIssues === "number")
        lines.push(`- Medium issues: ${sa.mediumIssues}`);
      if (typeof sa.lowIssues === "number")
        lines.push(`- Low issues: ${sa.lowIssues}`);
      if (typeof sa.totalIssues === "number")
        lines.push(`- Total issues: ${sa.totalIssues}`);
      if (typeof sa.pagesIndexed === "number")
        lines.push(`- Pages indexed: ${sa.pagesIndexed}`);
      lines.push("");
    }

    if (r.seoDeep.rankingKeywords?.length) {
      lines.push("### Ranking Keywords");
      lines.push("");
      lines.push("| Keyword | Position | Volume | Difficulty | CPC | Intent |");
      lines.push("| --- | --- | --- | --- | --- | --- |");
      for (const k of r.seoDeep.rankingKeywords) {
        lines.push(
          `| ${k.keyword} | ${k.position ?? "N/A"} | ${k.volume ?? "N/A"} | ${k.difficulty ?? "N/A"} | ${k.cpc ?? "N/A"} | ${k.intent || "N/A"} |`
        );
      }
      lines.push("");
    }
    if (r.seoDeep.opportunityKeywords?.length) {
      lines.push("### Opportunity Keywords");
      lines.push("");
      lines.push("| Keyword | Volume | Difficulty | CPC | Intent |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const k of r.seoDeep.opportunityKeywords) {
        lines.push(
          `| ${k.keyword} | ${k.volume ?? "N/A"} | ${k.difficulty ?? "N/A"} | ${k.cpc ?? "N/A"} | ${k.intent || "N/A"} |`
        );
      }
      lines.push("");
    }
    if (r.seoDeep.listings?.length) {
      lines.push("### Listings");
      lines.push("");
      lines.push("| Directory | Status | NAP accurate | Notes |");
      lines.push("| --- | --- | --- | --- |");
      for (const l of r.seoDeep.listings) {
        lines.push(
          `| ${l.directory} | ${l.status} | ${l.napAccurate === undefined ? "N/A" : l.napAccurate ? "Yes" : "No"} | ${safe(l.notes || "")} |`
        );
      }
      lines.push("");
    }
  }

  // Website performance
  const wp = r.websitePerformance;
  if (wp) {
    lines.push("## Website Performance");
    lines.push("");
    lines.push(`- Performance: ${wp.performanceScore ?? "N/A"}`);
    lines.push(`- Mobile: ${wp.mobileScore ?? "N/A"}`);
    lines.push(`- Accessibility: ${wp.accessibilityScore ?? "N/A"}`);
    lines.push(`- SEO: ${wp.seoScore ?? "N/A"}`);
    if (wp.coreWebVitals) {
      const cv = wp.coreWebVitals;
      const writeVital = (label: string, v: CoreWebVital | undefined) => {
        if (!v) return;
        lines.push(
          `- ${label} (${v.fullName}): ${v.value ?? "N/A"} — ${v.rating ?? "N/A"}. ${safe(v.plainEnglish)}`
        );
      };
      writeVital("LCP", cv.lcp);
      writeVital("CLS", cv.cls);
      writeVital("FID", cv.fid);
    }
    if (wp.conversionBlockers?.length) {
      lines.push("");
      lines.push("### Conversion Blockers");
      for (const c of wp.conversionBlockers) lines.push(`- ${safe(c)}`);
    }
    if (wp.securityNotes?.length) {
      lines.push("");
      lines.push("### Security Notes");
      for (const c of wp.securityNotes) lines.push(`- ${safe(c)}`);
    }
    lines.push("");
  }

  // Immediate Action Plan
  const plan = r.immediateActionPlan;
  if (plan) {
    lines.push("## Immediate Action Plan");
    lines.push("");
    if (plan.summary) {
      lines.push(safe(plan.summary));
      lines.push("");
    }
    const sections: { title: string; items?: ImmediateActionItem[] }[] = [
      { title: "AI Automation", items: plan.aiAutomation },
      { title: "SEO + Listings", items: plan.seoListings },
      { title: "Reputation", items: plan.reputation },
      { title: "Social Media", items: plan.socialMedia },
      { title: "Quick Wins", items: plan.quickWins },
    ];
    for (const s of sections) {
      if (!s.items?.length) continue;
      lines.push(`### ${s.title}`);
      for (const it of s.items) {
        lines.push(`- **[${it.priority}]** ${safe(it.task)} — ${safe(it.why)}`);
      }
      lines.push("");
    }
    if (plan.expectedOutcomes?.length) {
      lines.push("### Expected Outcomes");
      for (const o of plan.expectedOutcomes) lines.push(`- ${safe(o)}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

/* ----------------------------------------------------------------------
 * ClientFacingDeckCard
 *
 * Sends the current audit to Manus to produce a simplified, image-mode
 * 10-slide client-facing deck. Lets the user attach a logo, watch a
 * spinner while Manus generates, and then download the slide zip + PDF.
 *
 * Polls /api/audits/:id/manus-status every 6s while a task is running.
 * --------------------------------------------------------------------- */
type ManusDeckState = {
  status?: "idle" | "queued" | "running" | "complete" | "failed";
  taskId?: string;
  taskUrl?: string;
  error?: string;
  hasZip?: boolean;
  hasPdf?: boolean;
  hasPptx?: boolean;
  slideCount?: number;
  startedAt?: number;
  completedAt?: number;
  logoAdjusted?: boolean;
};

function ClientFacingDeckCard({ auditId }: { auditId: string }) {
  const [logo, setLogo] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [state, setState] = useState<ManusDeckState>({ status: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
  const startUrl = `${API_BASE}/api/audits/${auditId}/send-to-manus`;
  const statusUrl = `${API_BASE}/api/audits/${auditId}/manus-status`;
  const pdfUrl = `${API_BASE}/api/audits/${auditId}/manus-deck-pdf`;
  const zipUrl = `${API_BASE}/api/audits/${auditId}/manus-deck-zip`;

  // Initial load + polling loop.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const res = await fetch(statusUrl, { credentials: "include" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = (await res.json()) as ManusDeckState;
        if (cancelled) return;
        setState(json);
        // Continue polling only while running/queued.
        if (json.status === "queued" || json.status === "running") {
          timer = setTimeout(tick, 6000);
        }
      } catch {
        if (cancelled) return;
        // Retry in 15s on transient errors.
        timer = setTimeout(tick, 15000);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [statusUrl]);

  async function handleSend() {
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const fd = new FormData();
      if (logo) fd.append("logo", logo);
      const res = await fetch(startUrl, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`);
      toast({
        title: "Sent to Manus",
        description: "Generating the client-facing deck. This usually takes a few minutes.",
      });
      setState({ status: "running", taskId: json.taskId, taskUrl: json.taskUrl });
    } catch (err: any) {
      setErrorMsg(err?.message || "Could not start the Manus task.");
    } finally {
      setSubmitting(false);
    }
  }

  const isRunning = state.status === "queued" || state.status === "running";
  const isComplete = state.status === "complete";
  const isFailed = state.status === "failed";

  function elapsedLabel(): string {
    if (!state.startedAt) return "under a minute";
    const ms = Date.now() - state.startedAt;
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (m === 0) return `${s}s`;
    return `${m}m ${s.toString().padStart(2, "0")}s`;
  }

  function formatStamp(ms?: number): string {
    if (!ms) return "";
    const d = new Date(ms);
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${date} at ${time}`;
  }

  // Inline ElevenLabs script generation + viewer.
  // Pulls (or regenerates) the script from the deck PDF, opens a dialog with
  // edit + download, and surfaces a persistent "View Script" button after
  // generation so the user never has to scroll hunting for it.
  const scriptUrl = `${API_BASE}/api/audits/${auditId}/elevenlabs-script`;
  const [scriptBusy, setScriptBusy] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [scriptText, setScriptText] = useState("");
  const [scriptHasGenerated, setScriptHasGenerated] = useState(false);
  const [scriptGeneratedAt, setScriptGeneratedAt] = useState<number | undefined>();
  const [scriptFilename, setScriptFilename] = useState("elevenlabs-dj2-script.txt");
  const [scriptDirty, setScriptDirty] = useState(false);
  const [scriptSaving, setScriptSaving] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);

  // On mount (when deck is complete), probe the script endpoint once so a
  // previously-generated script is recognized without re-running generation.
  useEffect(() => {
    if (!isComplete) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${scriptUrl}?format=json&peek=1`, {
          credentials: "include",
        });
        if (!res.ok) return; // 404 etc. just means not yet generated
        const json = await res.json();
        if (cancelled) return;
        // hasGenerated=true means a script exists in the audit history but the
        // body isn't cached server-side (only edited scripts are persisted).
        // The card shows "Last generated at X" + a View button that will
        // regenerate on demand.
        if (json?.hasGenerated || json?.script) {
          setScriptText(json.script || "");
          setScriptHasGenerated(true);
          setScriptFilename(json.filename || "elevenlabs-dj2-script.txt");
          setScriptGeneratedAt(json.generatedAt);
        }
      } catch {
        /* ignore probe errors */
      }
    })();
    return () => { cancelled = true; };
  }, [isComplete, scriptUrl]);

  async function handleGenerateScript(opts: { regenerate?: boolean } = {}) {
    setScriptBusy(true);
    setScriptError(null);
    try {
      const url = opts.regenerate
        ? `${scriptUrl}?format=json&regenerate=1`
        : `${scriptUrl}?format=json`;
      const res = await fetch(url, { credentials: "include" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`);
      setScriptText(json.script || "");
      setScriptFilename(json.filename || "elevenlabs-dj2-script.txt");
      setScriptGeneratedAt(json.generatedAt || Date.now());
      setScriptHasGenerated(true);
      setScriptDirty(false);
      setScriptOpen(true);
      queryClient.invalidateQueries({ queryKey: ["/api/audits", auditId] });
    } catch (err: any) {
      const msg = err?.message || "Unknown error.";
      setScriptError(msg);
      toast({
        title: "Could not generate the script",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setScriptBusy(false);
    }
  }

  async function handleSaveScript() {
    setScriptSaving(true);
    setScriptError(null);
    try {
      const res = await fetch(scriptUrl, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: scriptText }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.message || `HTTP ${res.status}`);
      }
      setScriptDirty(false);
      toast({ title: "Script saved", description: "Your edits are stored on this audit." });
      queryClient.invalidateQueries({ queryKey: ["/api/audits", auditId] });
    } catch (err: any) {
      setScriptError(err?.message || "Save failed.");
    } finally {
      setScriptSaving(false);
    }
  }

  function handleDownloadScript() {
    const blob = new Blob([scriptText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = scriptFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <Card
      id="client-facing-deck"
      className="no-print border-card-border p-6 md:p-8 transition-shadow duration-500"
      data-testid="section-client-facing-deck"
    >
      <SectionLabel icon={Presentation}>Client-Facing Deck</SectionLabel>
      <h3 className="mt-2 text-lg font-bold tracking-tight">
        Send to Manus, Client-Facing Deck
      </h3>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Manus produces a polished PDF deck the business owner can actually
        follow: ranking keywords, opportunity keywords, listings gap, and the
        reputation story. You can attach the client logo so it appears on
        every slide.
      </p>

      <div className="mt-5 grid gap-5">
        {/* Logo picker (only shown when no task is running yet) */}
        {!isRunning && !isComplete && (
          <div className="grid gap-2">
            <Label>Client logo (optional)</Label>
            {logo ? (
              <div
                className="flex items-center gap-3 rounded-lg border border-card-border bg-secondary/40 p-3"
                data-testid="manus-logo-file"
              >
                <ImageIcon className="h-5 w-5 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{logo.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {(logo.size / 1024).toFixed(0)} KB
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setLogo(null)}
                  disabled={submitting}
                  data-testid="manus-logo-remove"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="hover-elevate flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-secondary/30 px-4 py-6 text-sm"
                data-testid="manus-logo-dropzone"
              >
                <Upload className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm font-medium">Click to upload logo (PNG, JPG, SVG)</span>
                <span className="text-xs text-muted-foreground">
                  Skip if you do not have a logo yet, Manus will use brand colors
                </span>
              </button>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => setLogo(e.target.files?.[0] ?? null)}
            />
          </div>
        )}

        {/* Running spinner */}
        {isRunning && (
          <div
            className="flex flex-col gap-3 rounded-lg border border-accent/40 bg-accent/10 p-4"
            data-testid="manus-deck-running"
          >
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 shrink-0 animate-spin text-accent" />
              <div className="min-w-0">
                <div className="text-sm font-medium">Manus is generating slides</div>
                <div className="text-xs text-muted-foreground">
                  Started {formatStamp(state.startedAt)}. Elapsed: {elapsedLabel()}. Image-mode decks usually take five to fifteen minutes.
                </div>
              </div>
            </div>
            {state.taskUrl && (
              <a
                href={state.taskUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-accent underline-offset-2 hover:underline"
              >
                Open the live Manus task
              </a>
            )}
          </div>
        )}

        {/* Complete: download buttons */}
        {isComplete && (
          <div
            className="flex flex-col gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4"
            data-testid="manus-deck-complete"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    Deck ready ({state.slideCount ?? "?"} slides)
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {state.completedAt
                      ? `Generated ${formatStamp(state.completedAt)}`
                      : "Download the PDF or the labeled slide images (slide-01.png, slide-02.png, ...)."}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {state.hasPdf && (
                  <Button
                    asChild
                    className="bg-accent text-accent-foreground hover:bg-accent/90"
                    data-testid="button-download-deck-pdf"
                  >
                    <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
                      <FileDown className="mr-1.5 h-4 w-4" />
                      Download PDF
                    </a>
                  </Button>
                )}
                {state.hasZip && (
                  <Button asChild variant="outline" data-testid="button-download-deck-zip">
                    <a href={zipUrl} target="_blank" rel="noopener noreferrer">
                      <FileDown className="mr-1.5 h-4 w-4" />
                      Download Slide Images (ZIP)
                    </a>
                  </Button>
                )}
              </div>
            </div>
            {state.logoAdjusted && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                Your logo was placed on a white card before sending so it stays crisp on any slide background.
              </div>
            )}
            {/* One-click ElevenLabs script generation from the deck PDF.
                Skips the manual upload step in the Final Deliverable section. */}
            <div className="mt-1 flex flex-col gap-2 border-t border-emerald-500/20 pt-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {scriptHasGenerated ? "ElevenLabs DJ #2 script" : "Next: ElevenLabs DJ #2 script"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {scriptHasGenerated ? (
                    <>Last generated {formatStamp(scriptGeneratedAt) || "just now"}. View, edit, or download.</>
                  ) : (
                    <>Generate the narration script straight from this deck PDF. You can review and edit it right here.</>
                  )}
                </div>
                {scriptError && (
                  <div className="mt-1 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                    {scriptError}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {scriptHasGenerated && scriptText && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleDownloadScript}
                    data-testid="button-download-elevenlabs-from-deck"
                  >
                    <FileDown className="mr-1.5 h-4 w-4" />
                    Download .txt
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={async () => {
                    if (scriptText) {
                      // Already loaded in memory, just open dialog.
                      setScriptOpen(true);
                    } else {
                      // Either fresh generate (no prior script) or re-load
                      // body for a previously generated script.
                      await handleGenerateScript();
                    }
                  }}
                  disabled={scriptBusy || !state.hasPdf}
                  data-testid="button-generate-elevenlabs-from-deck"
                >
                  {scriptBusy ? (
                    <>
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      Generating…
                    </>
                  ) : scriptHasGenerated && scriptText ? (
                    <>
                      <Eye className="mr-1.5 h-4 w-4" />
                      View &amp; Edit Script
                    </>
                  ) : scriptHasGenerated ? (
                    <>
                      <Eye className="mr-1.5 h-4 w-4" />
                      View Script
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-1.5 h-4 w-4" />
                      Generate ElevenLabs Script
                    </>
                  )}
                </Button>
              </div>
            </div>
            {state.taskUrl && (
              <a
                href={state.taskUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                Open the Manus task to review or revise
              </a>
            )}
          </div>
        )}

        {/* Failed */}
        {isFailed && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Manus task failed: {state.error || "unknown error"}
          </div>
        )}

        {errorMsg && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {errorMsg}
          </div>
        )}

        {/* Send / Resend button */}
        {!isRunning && (
          <div className="flex justify-end">
            <Button
              type="button"
              onClick={handleSend}
              disabled={submitting}
              className="bg-accent text-accent-foreground hover:bg-accent/90"
              data-testid="button-send-to-manus"
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : isComplete || isFailed ? (
                <>
                  <RefreshCw className="mr-1.5 h-4 w-4" />
                  Regenerate Deck
                </>
              ) : (
                <>
                  <Send className="mr-1.5 h-4 w-4" />
                  Send to Manus
                </>
              )}
            </Button>
          </div>
        )}
      </div>

      {/* -------- Inline ElevenLabs script viewer + editor -------- */}
      <Dialog
        open={scriptOpen}
        onOpenChange={(o) => {
          if (!o && scriptDirty) {
            const ok = window.confirm("You have unsaved edits. Close anyway?");
            if (!ok) return;
          }
          setScriptOpen(o);
        }}
      >
        <DialogContent
          className="max-w-4xl"
          data-testid="dialog-deck-elevenlabs-script"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkle className="h-5 w-5 text-accent" />
              ElevenLabs DJ #2 Script
              {scriptDirty && (
                <Badge variant="outline" className="ml-1 border-amber-500 text-xs text-amber-600">
                  Unsaved changes
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              Preview, edit, save, and download the narration script. Edits are
              stored on this audit and served next time you open it. Regenerate
              to rebuild from the Manus deck PDF.
              {scriptGeneratedAt && (
                <> Generated {formatStamp(scriptGeneratedAt)}.</>
              )}
            </DialogDescription>
          </DialogHeader>

          {scriptBusy && !scriptText ? (
            <div className="flex h-96 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              Generating script… this takes about 20 seconds.
            </div>
          ) : (
            <Textarea
              value={scriptText}
              onChange={(e) => {
                setScriptText(e.target.value);
                setScriptDirty(true);
              }}
              className="h-96 max-h-[60vh] min-h-[24rem] font-mono text-xs"
              spellCheck={false}
              data-testid="textarea-deck-elevenlabs-script"
            />
          )}

          {scriptError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {scriptError}
            </div>
          )}

          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleGenerateScript({ regenerate: true })}
                disabled={scriptBusy || scriptSaving}
                data-testid="button-deck-regenerate-script"
              >
                <RotateCw className="mr-1.5 h-4 w-4" />
                Regenerate
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleDownloadScript}
                disabled={!scriptText || scriptBusy}
                data-testid="button-deck-download-script"
              >
                <FileDown className="mr-1.5 h-4 w-4" />
                Download .txt
              </Button>
              <Button
                type="button"
                onClick={handleSaveScript}
                disabled={!scriptDirty || scriptSaving || scriptBusy}
                className="bg-accent text-accent-foreground hover:bg-accent/90"
                data-testid="button-deck-save-script"
              >
                {scriptSaving ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <Save className="mr-1.5 h-4 w-4" />
                    Save
                  </>
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
