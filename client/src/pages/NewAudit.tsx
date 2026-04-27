import { useEffect, useState, useRef } from "react";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import {
  UploadCloud,
  FileText,
  X,
  ArrowRight,
  Loader2,
  Plus,
  Sparkles,
  CheckCircle2,
} from "lucide-react";

const API = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

type KeysearchSummary = {
  domainStrength: number | null;
  backlinks: number | null;
  referringDomains: number | null;
  organicKeywords: number | null;
  estTraffic: number | null;
  topCompetitorCount: number;
};

type KeysearchAutofetch = {
  domain: string;
  rows: any[];
  summary: KeysearchSummary;
};

export default function NewAudit() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [intake, setIntake] = useState<File | null>(null);
  const [vendasta, setVendasta] = useState<File | null>(null);
  const [keysearch, setKeysearch] = useState<File[]>([]);
  const [website, setWebsite] = useState("");
  const [clientName, setClientName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Keysearch auto-fetch state
  const [autofetchAvailable, setAutofetchAvailable] = useState(false);
  const [autofetching, setAutofetching] = useState(false);
  const [autofetched, setAutofetched] = useState<KeysearchAutofetch | null>(null);

  // Probe the server for whether the auto-fetch feature is configured.
  useEffect(() => {
    fetch(`${API}/api/health`)
      .then((r) => r.json())
      .then((d) => setAutofetchAvailable(!!d?.keysearchAutofetch))
      .catch(() => setAutofetchAvailable(false));
  }, []);

  const canSubmit = intake && vendasta && website.trim() && !submitting;

  async function handleAutofetch() {
    const domain = website.trim();
    if (!domain) {
      toast({
        variant: "destructive",
        title: "Enter the website URL first",
        description: "Paste the client domain in the field above and try again.",
      });
      return;
    }
    setAutofetching(true);
    try {
      const res = await fetch(`${API}/api/keysearch/lookup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Structured error from /api/keysearch/lookup — surface step + detail
        // and link to the debug screenshot if one was captured.
        const stepLabel: Record<string, string> = {
          config: "Configuration",
          launch: "Browser launch",
          navigate: "Reach Keysearch",
          login: "Login",
          "explorer-search": "Submit search",
          "results-timeout": "Wait for results",
          extraction: "Read results",
        };
        const step = data.step ? stepLabel[data.step] || data.step : null;
        const title = step
          ? `Keysearch failed at: ${step}`
          : "Could not pull from Keysearch";
        const parts: string[] = [];
        if (data.message) parts.push(data.message);
        if (data.detail) parts.push(`Detail: ${String(data.detail).slice(0, 240)}`);
        if (data.pageUrl) parts.push(`Page: ${data.pageUrl}`);
        const description = parts.join(" \u2014 ") || `Lookup failed (${res.status})`;
        const screenshotName: string | undefined = data.screenshotPath;
        toast({
          variant: "destructive",
          title,
          description,
          action: screenshotName ? (
            <ToastAction
              altText="View screenshot"
              onClick={() => {
                window.open(
                  `${API}/api/keysearch/debug-screenshot/${encodeURIComponent(screenshotName)}`,
                  "_blank",
                  "noopener,noreferrer",
                );
              }}
            >
              View screenshot
            </ToastAction>
          ) : undefined,
        });
        return;
      }
      setAutofetched({
        domain: data.domain,
        rows: Array.isArray(data.rows) ? data.rows : [],
        summary: data.summary || {
          domainStrength: null,
          backlinks: null,
          referringDomains: null,
          organicKeywords: null,
          estTraffic: null,
          topCompetitorCount: 0,
        },
      });
      toast({
        title: "Keysearch data captured",
        description: `${data.rows?.length || 0} keywords pulled for ${data.domain}.`,
      });
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Could not pull from Keysearch",
        description: e?.message || String(e),
      });
    } finally {
      setAutofetching(false);
    }
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append("intake", intake!);
      fd.append("vendasta", vendasta!);
      keysearch.forEach((f) => fd.append("keysearch", f));
      fd.append("website", website.trim());
      if (clientName.trim()) fd.append("clientName", clientName.trim());
      if (autofetched && autofetched.rows.length > 0) {
        fd.append("keysearchRows", JSON.stringify(autofetched.rows));
      }

      const res = await fetch(`${API}/api/audits`, { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Upload failed (${res.status})`);
      }
      const data = (await res.json()) as { id: string };
      setLocation(`/processing/${data.id}`);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Could not start audit", description: e.message });
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">New Audit</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight md:text-3xl">
          Upload client documents
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Provide the Client Intake Form, SMB Solution Audit, and the client website. Keysearch CSVs are optional but make the SEO section deeper.
        </p>
      </header>

      <Card className="space-y-6 border-card-border p-6">
        {/* Client name (optional) */}
        <div className="space-y-2">
          <Label htmlFor="clientName">Client name <span className="text-muted-foreground">(optional — auto-filled from intake)</span></Label>
          <Input
            id="clientName"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            placeholder="e.g. Acme Plumbing"
            data-testid="input-client-name"
          />
        </div>

        {/* Website */}
        <div className="space-y-2">
          <Label htmlFor="website">Client website URL <span className="text-destructive">*</span></Label>
          <Input
            id="website"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://acmeplumbing.com"
            data-testid="input-website"
          />
        </div>

        {/* Intake form */}
        <FileDrop
          label="Client Intake Form (PDF)"
          required
          file={intake}
          onChange={setIntake}
          accept="application/pdf"
          testId="dropzone-intake"
          description="The completed onboarding form your client filled out."
        />

        {/* SMB Solution Audit snapshot */}
        <FileDrop
          label="SMB Solution Audit (PDF)"
          required
          file={vendasta}
          onChange={setVendasta}
          accept="application/pdf"
          testId="dropzone-vendasta"
          description="Exported SMB Solution Audit covering listings, reviews, social, SEO, website."
        />

        {/* Keysearch — auto-fetch button (server-side scrape) + CSV upload fallback */}
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <Label>Keysearch data (optional)</Label>
            <span className="text-xs text-muted-foreground">
              Auto-fetch from your Keysearch account, or upload CSV exports.
            </span>
          </div>

          {autofetchAvailable && (
            <div className="rounded-lg border border-card-border bg-secondary/30 p-3">
              {autofetched ? (
                <div
                  className="flex flex-col gap-2"
                  data-testid="keysearch-autofetch-result"
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <CheckCircle2 className="h-4 w-4 text-accent" />
                    Pulled from Keysearch — {autofetched.domain}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
                    <Stat
                      label="Domain strength"
                      value={autofetched.summary.domainStrength}
                    />
                    <Stat label="Backlinks" value={autofetched.summary.backlinks} />
                    <Stat
                      label="Referring domains"
                      value={autofetched.summary.referringDomains}
                    />
                    <Stat
                      label="Organic keywords"
                      value={autofetched.summary.organicKeywords}
                    />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setAutofetched(null)}
                      data-testid="button-keysearch-reset"
                    >
                      <X className="mr-1 h-3 w-3" />
                      Clear
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleAutofetch}
                      disabled={autofetching}
                      data-testid="button-keysearch-refresh"
                    >
                      {autofetching ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Sparkles className="mr-1 h-3 w-3" />
                      )}
                      Re-fetch
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm">
                    <div className="font-medium">Auto-fetch from Keysearch</div>
                    <div className="text-xs text-muted-foreground">
                      Reads Domain Strength, backlinks, referring domains, and the
                      organic keyword table for the URL above.
                    </div>
                  </div>
                  <Button
                    type="button"
                    onClick={handleAutofetch}
                    disabled={autofetching || !website.trim()}
                    data-testid="button-keysearch-autofetch"
                  >
                    {autofetching ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="mr-2 h-4 w-4" />
                    )}
                    {autofetching ? "Pulling…" : "Auto-fetch from Keysearch"}
                  </Button>
                </div>
              )}
            </div>
          )}

          <MultiFileDrop
            label="Or upload Keysearch CSV exports"
            files={keysearch}
            onChange={setKeysearch}
            accept=".csv,text/csv"
            testId="dropzone-keysearch"
            description="Multiple CSVs are merged. Combines with auto-fetched data when both are present."
          />
        </div>

        <div className="flex justify-end pt-2">
          <Button
            size="lg"
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="bg-accent text-accent-foreground hover:bg-accent/90"
            data-testid="button-generate-audit"
          >
            {submitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ArrowRight className="ml-0 mr-2 h-4 w-4" />
            )}
            Generate audit
          </Button>
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex flex-col">
      <span className="font-medium text-foreground">
        {value === null || value === undefined ? "—" : value.toLocaleString()}
      </span>
      <span>{label}</span>
    </div>
  );
}

function FileDrop({
  label,
  required,
  file,
  onChange,
  accept,
  testId,
  description,
}: {
  label: string;
  required?: boolean;
  file: File | null;
  onChange: (f: File | null) => void;
  accept: string;
  testId: string;
  description?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <Label>
          {label}
          {required && <span className="text-destructive"> *</span>}
        </Label>
        {description && <span className="text-xs text-muted-foreground">{description}</span>}
      </div>

      {file ? (
        <div
          className="flex items-center gap-3 rounded-lg border border-card-border bg-secondary/40 p-3"
          data-testid={`${testId}-file`}
        >
          <FileText className="h-5 w-5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{file.name}</div>
            <div className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onChange(null)}
            data-testid={`${testId}-remove`}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f) onChange(f);
          }}
          className={`hover-elevate flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed bg-secondary/30 px-4 py-8 text-sm transition-colors ${
            drag ? "border-accent bg-accent/10" : "border-border"
          }`}
          data-testid={testId}
        >
          <UploadCloud className="h-6 w-6 text-muted-foreground" />
          <span className="text-sm font-medium">Click or drag PDF here</span>
          <span className="text-xs text-muted-foreground">Up to 25 MB</span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}

function MultiFileDrop({
  label,
  files,
  onChange,
  accept,
  testId,
  description,
}: {
  label: string;
  files: File[];
  onChange: (f: File[]) => void;
  accept: string;
  testId: string;
  description?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <Label>{label}</Label>
        {description && <span className="text-xs text-muted-foreground">{description}</span>}
      </div>

      <div className="space-y-2">
        {files.map((file, i) => (
          <div
            key={`${file.name}-${i}`}
            className="flex items-center gap-3 rounded-lg border border-card-border bg-secondary/40 p-3"
          >
            <FileText className="h-5 w-5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{file.name}</div>
              <div className="text-xs text-muted-foreground">
                {(file.size / 1024).toFixed(0)} KB
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onChange(files.filter((_, idx) => idx !== i))}
              data-testid={`${testId}-remove-${i}`}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="hover-elevate flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-secondary/30 px-4 py-4 text-sm font-medium text-muted-foreground"
          data-testid={testId}
        >
          <Plus className="h-4 w-4" />
          {files.length === 0 ? "Add Keysearch CSV" : "Add another CSV"}
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        className="hidden"
        onChange={(e) => {
          const list = Array.from(e.target.files || []);
          onChange([...files, ...list]);
          if (inputRef.current) inputRef.current.value = "";
        }}
      />
    </div>
  );
}
