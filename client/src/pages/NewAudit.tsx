import { useEffect, useState, useRef } from "react";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
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

type SeoSummary = {
  domainStrength: number | null;
  backlinks: number | null;
  referringDomains: number | null;
  organicKeywords: number | null;
  estTraffic: number | null;
  topCompetitorCount: number;
};

type SeoAutofetch = {
  domain: string;
  rows: any[];
  summary: SeoSummary;
};

export default function NewAudit() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [intake, setIntake] = useState<File | null>(null);
  const [vendasta, setVendasta] = useState<File | null>(null);
  const [keysearch, setKeysearch] = useState<File[]>([]);
  const [website, setWebsite] = useState("");
  const [clientName, setClientName] = useState("");
  const [ownerFirstName, setOwnerFirstName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Intake auto-fill state — fires the moment a PDF is dropped onto the intake dropzone.
  const [intakePreviewing, setIntakePreviewing] = useState(false);

  // SEO auto-fetch state (DataForSEO)
  const [autofetchAvailable, setAutofetchAvailable] = useState(false);
  const [autofetching, setAutofetching] = useState(false);
  const [autofetched, setAutofetched] = useState<SeoAutofetch | null>(null);

  // Probe the server for whether the auto-fetch feature is configured.
  // Backend now reports `dataForSEO`; keep `keysearchAutofetch` as a fallback
  // for any older Render deploy that hasn't picked up the new field.
  useEffect(() => {
    fetch(`${API}/api/health`)
      .then((r) => r.json())
      .then((d) => setAutofetchAvailable(!!(d?.dataForSEO ?? d?.keysearchAutofetch)))
      .catch(() => setAutofetchAvailable(false));
  }, []);

  /**
   * The moment the user drops the intake PDF, POST it to /api/intake/preview
   * and auto-fill the form fields (owner first name, business name, website).
   * We never overwrite a field the user has already typed into.
   */
  useEffect(() => {
    if (!intake) return;
    let cancelled = false;
    console.log("[intake-preview] file dropped, calling /api/intake/preview", {
      name: intake.name,
      size: intake.size,
      type: intake.type,
    });
    (async () => {
      setIntakePreviewing(true);
      try {
        const fd = new FormData();
        fd.append("intake", intake);
        const res = await fetch(`${API}/api/intake/preview`, {
          method: "POST",
          body: fd,
          credentials: "include",
        });
        console.log("[intake-preview] response status", res.status);
        const data = await res.json().catch(() => ({}));
        console.log("[intake-preview] response body", data);
        if (cancelled) return;
        if (!res.ok) {
          toast({
            variant: "destructive",
            title: "Couldn't read intake form",
            description: data?.message || `Server returned ${res.status}. Try a different PDF or fill the fields manually.`,
          });
          return;
        }
        // Only fill fields the user hasn't already typed into.
        let filled = 0;
        if (data.ownerFirstName && !ownerFirstName.trim()) { setOwnerFirstName(data.ownerFirstName); filled++; }
        if (data.clientName && !clientName.trim()) { setClientName(data.clientName); filled++; }
        if (data.website && !website.trim()) { setWebsite(data.website); filled++; }
        if (filled === 0) {
          toast({
            variant: "destructive",
            title: "No fields detected",
            description: "The intake PDF was readable but no owner, business, or website was found. Fill the fields manually.",
          });
        } else {
          toast({
            title: `Intake auto-filled (${filled} field${filled === 1 ? "" : "s"})`,
            description: [
              data.ownerFirstName && `Owner: ${data.ownerFirstName}`,
              data.clientName && `Business: ${data.clientName}`,
              data.metroArea && `Metro: ${data.metroArea}`,
            ].filter(Boolean).join(" \u00b7 ") || "Form fields populated from the intake PDF.",
          });
        }
      } catch (err: any) {
        console.error("[intake-preview] fetch failed", err);
        if (!cancelled) {
          toast({
            variant: "destructive",
            title: "Intake preview failed",
            description: err?.message || "Network error reading the intake form.",
          });
        }
      } finally {
        if (!cancelled) setIntakePreviewing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intake]);

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
        // Structured error from /api/keysearch/lookup (now backed by DataForSEO).
        const stepLabel: Record<string, string> = {
          config: "Configuration",
          validate: "Validate domain",
          overview: "Domain overview",
          keywords: "Keyword data",
          backlinks: "Backlink data",
          competitors: "Competitor data",
          fetch: "Fetch SEO data",
        };
        const step = data.step ? stepLabel[data.step] || data.step : null;
        const title = step ? `SEO fetch failed at: ${step}` : "Could not fetch SEO data";
        const parts: string[] = [];
        if (data.message) parts.push(data.message);
        if (data.detail) parts.push(`Detail: ${String(data.detail).slice(0, 240)}`);
        const description = parts.join(" \u2014 ") || `Lookup failed (${res.status})`;
        toast({
          variant: "destructive",
          title,
          description,
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
        title: "SEO data captured",
        description: `${data.rows?.length || 0} keywords pulled for ${data.domain}.`,
      });
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Could not fetch SEO data",
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
      if (ownerFirstName.trim()) fd.append("ownerFirstName", ownerFirstName.trim());
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
          Provide the Client Intake Form, SMB Solution Audit, and the client website. SEO data is fetched automatically; CSV uploads are optional and add depth.
        </p>
      </header>

      <Card className="space-y-6 border-card-border p-6">
        {/* Owner first name */}
        <div className="space-y-2">
          <Label htmlFor="ownerFirstName">
            Owner first name <span className="text-muted-foreground">(auto-filled from intake)</span>
          </Label>
          <Input
            id="ownerFirstName"
            value={ownerFirstName}
            onChange={(e) => setOwnerFirstName(e.target.value)}
            placeholder="e.g. Tawana"
            data-testid="input-owner-first-name"
          />
        </div>

        {/* Client name */}
        <div className="space-y-2">
          <Label htmlFor="clientName">
            Business name <span className="text-muted-foreground">(auto-filled from intake)</span>
          </Label>
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
          <Label htmlFor="website">
            Client website URL <span className="text-destructive">*</span>{" "}
            <span className="text-muted-foreground">(auto-filled from intake)</span>
          </Label>
          <Input
            id="website"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://acmeplumbing.com"
            data-testid="input-website"
          />
        </div>

        {/* Intake form */}
        <div className="space-y-2">
          <FileDrop
            label="Client Intake Form (PDF)"
            required
            file={intake}
            onChange={setIntake}
            accept="application/pdf"
            testId="dropzone-intake"
            description="The completed onboarding form your client filled out."
          />
          {intakePreviewing && (
            <div className="flex items-center gap-2 rounded-md border border-card-border bg-accent/10 px-3 py-2 text-xs text-accent" data-testid="intake-preview-status">
              <Loader2 className="h-3 w-3 animate-spin" />
              Reading intake form and auto-filling fields…
            </div>
          )}
        </div>

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

        {/* SEO data — auto-fetch (DataForSEO) + CSV upload fallback */}
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <Label>SEO data</Label>
            <span className="text-xs text-muted-foreground">
              Auto-fetched from DataForSEO. CSV uploads optional.
            </span>
          </div>

          {autofetchAvailable && (
            <div className="rounded-lg border border-card-border bg-secondary/30 p-3">
              {autofetched ? (
                <div
                  className="flex flex-col gap-2"
                  data-testid="seo-autofetch-result"
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <CheckCircle2 className="h-4 w-4 text-accent" />
                    SEO data captured — {autofetched.domain}
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
                      data-testid="button-seo-reset"
                    >
                      <X className="mr-1 h-3 w-3" />
                      Clear
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleAutofetch}
                      disabled={autofetching}
                      data-testid="button-seo-refresh"
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
                    <div className="font-medium">Fetch SEO data</div>
                    <div className="text-xs text-muted-foreground">
                      Reads Domain Strength, backlinks, referring domains, top
                      competitors, and the organic keyword table for the URL above.
                    </div>
                  </div>
                  <Button
                    type="button"
                    onClick={handleAutofetch}
                    disabled={autofetching || !website.trim()}
                    data-testid="button-seo-autofetch"
                  >
                    {autofetching ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="mr-2 h-4 w-4" />
                    )}
                    {autofetching ? "Pulling…" : "Auto-fetch SEO data"}
                  </Button>
                </div>
              )}
            </div>
          )}

          <MultiFileDrop
            label="Or upload SEO data CSV exports (optional)"
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
          {files.length === 0 ? "Add SEO data CSV" : "Add another CSV"}
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
