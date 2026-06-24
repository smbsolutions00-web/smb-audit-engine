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
} from "lucide-react";

const API = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export default function NewAudit() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [intake, setIntake] = useState<File | null>(null);
  const [vendasta, setVendasta] = useState<File | null>(null);
  const [website, setWebsite] = useState("");
  const [clientName, setClientName] = useState("");
  const [ownerFirstName, setOwnerFirstName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Intake auto-fill state: fires the moment a PDF is dropped onto the intake dropzone.
  const [intakePreviewing, setIntakePreviewing] = useState(false);

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

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append("intake", intake!);
      fd.append("vendasta", vendasta!);
      fd.append("website", website.trim());
      if (clientName.trim()) fd.append("clientName", clientName.trim());
      if (ownerFirstName.trim()) fd.append("ownerFirstName", ownerFirstName.trim());

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
          Provide the Client Intake Form, Digital Report Card, and the client website.
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

        {/* Digital Report Card snapshot */}
        <FileDrop
          label="Digital Report Card (PDF)"
          required
          file={vendasta}
          onChange={setVendasta}
          accept="application/pdf"
          testId="dropzone-vendasta"
          description="Exported Digital Report Card covering listings, reviews, social, SEO, website."
        />

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

