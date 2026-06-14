import { useEffect, useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2, AlertCircle, Sparkles, MinusCircle, RefreshCw } from "lucide-react";

interface AuditDetail {
  id: string;
  status: "processing" | "complete" | "failed";
  errorMessage?: string;
  intakeData?: unknown;
  vendastaData?: unknown;
  keysearchData?: unknown[] | null;
  reportData?: unknown;
}

const STAGES = [
  "Parsing intake form",
  "Parsing SMB Solution Audit",
  "Reading Keysearch keywords",
  "Extracting structured data",
  "Analyzing the Four Pillars",
  "Generating immediate plan of action",
];

export default function Processing() {
  const [match, params] = useRoute("/processing/:id");
  const [, setLocation] = useLocation();
  const id = params?.id || "";

  const [stageIdx, setStageIdx] = useState(0);

  const { data, isError } = useQuery<AuditDetail>({
    queryKey: ["/api/audits", id],
    enabled: !!id,
    refetchInterval: (q) => {
      const d = q.state.data as AuditDetail | undefined;
      return d?.status === "processing" || !d ? 3000 : false;
    },
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/audits/${id}`);
      return res.json();
    },
  });

  useEffect(() => {
    if (!data || data.status !== "processing") return;
    // advance the visible stage based on what data is available
    const t = setInterval(() => {
      setStageIdx((s) => Math.min(s + 1, STAGES.length - 1));
    }, 5500);
    return () => clearInterval(t);
  }, [data]);

  useEffect(() => {
    if (data?.status === "complete") {
      setLocation(`/audit/${id}`);
    }
  }, [data, id, setLocation]);

  const retryMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/audits/${id}/retry`);
      return res.json() as Promise<{ id: string }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/audits", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/audits"] });
      setStageIdx(4); // jump back to "Analyzing the Four Pillars" — the report step
    },
  });

  if (!match) return null;

  if (isError || data?.status === "failed") {
    const canRetry = !!data && data.status === "failed";
    return (
      <div className="mx-auto max-w-xl">
        <Card className="space-y-4 border-card-border p-8 text-center">
          <AlertCircle className="mx-auto h-10 w-10 text-destructive" />
          <h2 className="text-lg font-semibold">Audit failed to generate</h2>
          <p className="text-sm text-muted-foreground">
            {data?.errorMessage || "Something went wrong while processing the documents. Try again. If it persists, double-check the PDFs are valid."}
          </p>
          <div className="flex justify-center gap-2">
            <Button variant="outline" onClick={() => setLocation("/")} data-testid="button-back-dashboard">
              Back to dashboard
            </Button>
            {canRetry && (
              <Button
                onClick={() => retryMutation.mutate()}
                disabled={retryMutation.isPending}
                className="bg-accent text-accent-foreground hover:bg-accent/90"
                data-testid="button-retry"
              >
                {retryMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Retry
              </Button>
            )}
            <Button variant="outline" onClick={() => setLocation("/new")} data-testid="button-new">
              Start new
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl">
      <Card className="space-y-6 border-card-border p-8">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15">
            <Sparkles className="h-6 w-6 text-accent" />
          </div>
          <h2 className="text-xl font-bold tracking-tight">Generating your audit</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            This typically takes 60–90 seconds. Stay on this screen — we'll redirect you when it's ready.
          </p>
        </div>

        <ul className="space-y-2.5">
          {STAGES.map((stage, i) => {
            const done = i < stageIdx;
            const active = i === stageIdx;
            // Stage 2 is "Reading Keysearch keywords" — mark as Skipped when no CSV was uploaded.
            // We can only know this once keysearchData has been written by the server (after stage 1).
            const isKeysearchStage = i === 2;
            const keysearchUploaded =
              Array.isArray(data?.keysearchData) && (data?.keysearchData as unknown[]).length > 0;
            const keysearchKnown =
              data?.keysearchData !== undefined && data?.keysearchData !== null;
            const skipped = isKeysearchStage && keysearchKnown && !keysearchUploaded;
            return (
              <li
                key={stage}
                className="flex items-center gap-3 rounded-lg border border-card-border bg-secondary/30 px-4 py-2.5"
                data-testid={`stage-${i}`}
              >
                {skipped ? (
                  <MinusCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : done ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-accent" />
                ) : active ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
                ) : (
                  <div className="h-4 w-4 shrink-0 rounded-full border border-border" />
                )}
                <span
                  className={`text-sm ${
                    skipped
                      ? "text-muted-foreground"
                      : done
                      ? "text-foreground"
                      : active
                      ? "font-medium text-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  {skipped ? `${stage} — skipped (no CSV)` : stage}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
