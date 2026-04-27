import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { UploadCloud, FileText, X, ArrowRight, Loader2, Plus } from "lucide-react";

const API = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export default function NewAudit() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [intake, setIntake] = useState<File | null>(null);
  const [vendasta, setVendasta] = useState<File | null>(null);
  const [keysearch, setKeysearch] = useState<File[]>([]);
  const [website, setWebsite] = useState("");
  const [clientName, setClientName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = intake && vendasta && website.trim() && !submitting;

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

        {/* Keysearch */}
        <MultiFileDrop
          label="Keysearch CSV exports (optional)"
          files={keysearch}
          onChange={setKeysearch}
          accept=".csv,text/csv"
          testId="dropzone-keysearch"
          description="Upload one or more Keysearch keyword exports. Powers the deep SEO section."
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
