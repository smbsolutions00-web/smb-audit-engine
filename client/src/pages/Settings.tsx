import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Settings as SettingsIcon, Database, KeyRound, Sparkles } from "lucide-react";
import wordmarkUrl from "@/assets/brand/wordmark.jpg";
import markUrl from "@/assets/brand/mark.jpg";

export default function Settings() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
          Settings
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight md:text-3xl">Configuration</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Wire up optional integrations as you grow.
        </p>
      </header>

      {/* Branding */}
      <Card className="space-y-3 border-card-border p-6">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-bold uppercase tracking-wider text-accent">Branding</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          The SMB Solutions wordmark and icon are wired throughout the app — dashboard header,
          report cover, and favicon. To swap them later, replace
          <code className="mx-1 rounded bg-secondary px-1 py-0.5 font-mono text-xs">client/src/assets/brand/wordmark.jpg</code>
          (full lockup) and
          <code className="mx-1 rounded bg-secondary px-1 py-0.5 font-mono text-xs">client/src/assets/brand/mark.jpg</code>
          (cube icon) and rebuild.
        </p>
        <div className="flex items-center gap-6 pt-2">
          <div className="rounded-lg border border-card-border bg-white p-3">
            <img src={wordmarkUrl} alt="SMB Solutions wordmark" className="h-10 w-auto" />
          </div>
          <div className="rounded-lg border border-card-border bg-white p-3">
            <img src={markUrl} alt="SMB Solutions mark" className="h-10 w-10" />
          </div>
        </div>
      </Card>

      {/* Keysearch API */}
      <Card className="space-y-3 border-card-border p-6">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-bold uppercase tracking-wider text-accent">
            Keysearch API (optional)
          </h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Provide your Keysearch.co API key to optionally pull live keyword data directly instead of
          uploading CSV exports. The audit engine works fully without this — CSV uploads are the
          primary path.
        </p>
        <div className="space-y-2">
          <Label htmlFor="keysearch">Keysearch API Key</Label>
          <Input
            id="keysearch"
            type="password"
            placeholder="Paste your Keysearch API key..."
            disabled
            data-testid="input-keysearch-key"
          />
          <p className="text-xs text-muted-foreground">
            Coming soon — for now, upload Keysearch CSV exports on the New Audit page.
          </p>
        </div>
      </Card>

      {/* Storage */}
      <Card className="space-y-3 border-card-border p-6">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-bold uppercase tracking-wider text-accent">Storage</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Audits are currently stored in the app's built-in database. Ready to graduate to Supabase
          for cross-device persistence?  Provide your <code className="rounded bg-secondary px-1 py-0.5 font-mono text-xs">SUPABASE_URL</code> and
          <code className="rounded bg-secondary px-1 py-0.5 font-mono text-xs"> SUPABASE_ANON_KEY</code> and we'll swap the storage layer over.
        </p>
      </Card>

      {/* Workflow */}
      <Card className="space-y-3 border-card-border p-6">
        <div className="flex items-center gap-2">
          <SettingsIcon className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-bold uppercase tracking-wider text-accent">Workflow</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          To deploy this app at <code className="rounded bg-secondary px-1 py-0.5 font-mono text-xs">audit.smbsolution.ai</code>,
          point a CNAME record from that subdomain at the deployed app URL in Cloudflare. We'll set
          this up after the first deploy.
        </p>
      </Card>
    </div>
  );
}
