import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import multer from "multer";
import { registerAuthRoutes, requireAuth } from "./auth";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, statSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { storage } from "./storage";
import {
  parsePdfBuffer,
  parseKeysearchCsv,
  extractIntake,
  extractVendasta,
  generateReport,
} from "./audit-engine";
import type { KeywordRow, ReportData, Grade, InsertAudit } from "@shared/schema";
import type { IntakeData, VendastaData } from "./audit-engine";
import { isLLMAvailable } from "./audit-engine";
import {
  fetchKeysearchExplorer,
  explorerToKeywordRows,
  isKeysearchAutofetchEnabled,
  isKeysearchCaptchaSolverEnabled,
  KeysearchScrapeError,
} from "./keysearch-scraper";
import { readdirSync } from "node:fs";
import { basename } from "node:path";

// Allowed mime types for ingest uploads (intake form, vendor audit, keysearch)
const INTAKE_AUDIT_MIMES = new Set([
  "application/pdf",
  "text/csv",
  "application/vnd.ms-excel",
  "text/plain",
  "application/octet-stream", // some browsers send this for csv
]);
const FINAL_PDF_MIMES = new Set(["application/pdf"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file
  fileFilter: (_req, file, cb) => {
    if (INTAKE_AUDIT_MIMES.has(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  /* Health / capabilities (always public, no auth) */
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      llmAvailable: isLLMAvailable(),
      keysearchAutofetch: isKeysearchAutofetchEnabled(),
      keysearchCaptchaSolver: isKeysearchCaptchaSolverEnabled(),
    });
  });

  /* Magic-link auth routes (always registered — they no-op when AUTH_ENABLED!="true") */
  registerAuthRoutes(app);

  /* Protect /api/* with the session cookie when AUTH_ENABLED="true".
     Public exceptions: health + the auth flow itself. */
  app.use("/api", (req, res, next) => {
    const publicPaths = new Set([
      "/health",
      "/auth/me",
      "/auth/request-link",
      "/auth/verify",
      "/auth/logout",
    ]);
    if (publicPaths.has(req.path)) return next();
    return requireAuth(req, res, next);
  });

  /* List audits */
  app.get("/api/audits", async (_req, res) => {
    const rows = await storage.listAudits();
    res.json(
      rows.map((r) => {
        let pillarGrades: Record<string, string | null> = {
          aiAutomation: null,
          seoListings: null,
          reputation: null,
          socialMedia: null,
        };
        try {
          if (r.reportData) {
            const rep = JSON.parse(r.reportData) as ReportData;
            const p = rep?.pillars;
            if (p) {
              pillarGrades = {
                aiAutomation: p.aiAutomation?.grade ?? null,
                seoListings: p.seoListings?.grade ?? null,
                reputation: p.reputation?.grade ?? null,
                socialMedia: p.socialMedia?.grade ?? null,
              };
            }
          }
        } catch {
          /* ignore */
        }
        return {
          id: r.id,
          clientName: r.clientName,
          clientWebsite: r.clientWebsite,
          industry: r.industry,
          location: r.location,
          status: r.status,
          overallGrade: r.overallGrade,
          overallScore: r.overallScore,
          delivered: !!(r as { delivered?: number }).delivered,
          pillarGrades,
          createdAt: r.createdAt,
        };
      })
    );
  });

  /* Toggle delivered status */
  app.patch("/api/audits/:id/delivered", async (req, res) => {
    const delivered = req.body?.delivered ? 1 : 0;
    await storage.updateAudit(req.params.id, { delivered } as Partial<InsertAudit>);
    res.json({ ok: true, delivered: !!delivered });
  });

  /* Get single audit (full payload) */
  app.get("/api/audits/:id", async (req, res) => {
    const audit = await storage.getAudit(req.params.id);
    if (!audit) return res.status(404).json({ message: "Audit not found" });
    res.json({
      ...audit,
      intakeData: audit.intakeData ? JSON.parse(audit.intakeData) : null,
      vendastaData: audit.vendastaData ? JSON.parse(audit.vendastaData) : null,
      keysearchData: audit.keysearchData ? JSON.parse(audit.keysearchData) : null,
      reportData: audit.reportData ? (JSON.parse(audit.reportData) as ReportData) : null,
    });
  });

  /* Delete audit */
  app.delete("/api/audits/:id", async (req, res) => {
    const ok = await storage.deleteAudit(req.params.id);
    res.json({ deleted: ok });
  });

  /* Edit audit business info (NAP + website + industry/location).
     Used by the inline "Edit business info" form on the report cover so
     Krystal can correct or fill in NAP for any audit at any time. */
  app.patch("/api/audits/:id", async (req, res) => {
    const audit = await storage.getAudit(req.params.id);
    if (!audit) return res.status(404).json({ message: "Audit not found" });

    const body = req.body || {};
    const allowed: (keyof typeof body)[] = [
      "clientName",
      "clientWebsite",
      "phone",
      "address",
      "location",
      "industry",
      "contactName",
      "email",
    ];
    const patch: Record<string, string | undefined> = {};
    for (const k of allowed) {
      if (typeof body[k] === "string") patch[k] = body[k].trim();
    }

    // Merge into intakeData JSON so the cover renders the new NAP
    const intake = audit.intakeData ? JSON.parse(audit.intakeData) : {};
    if (patch.clientName !== undefined) intake.clientName = patch.clientName;
    if (patch.contactName !== undefined) intake.contactName = patch.contactName;
    if (patch.email !== undefined) intake.email = patch.email;
    if (patch.phone !== undefined) intake.phone = patch.phone;
    if (patch.address !== undefined) intake.address = patch.address;
    if (patch.location !== undefined) intake.location = patch.location;
    if (patch.industry !== undefined) intake.industry = patch.industry;

    const updates: Record<string, unknown> = {
      intakeData: JSON.stringify(intake),
    };
    if (patch.clientName) updates.clientName = patch.clientName;
    if (patch.clientWebsite) updates.clientWebsite = patch.clientWebsite;
    if (patch.location !== undefined) updates.location = patch.location;
    if (patch.industry !== undefined) updates.industry = patch.industry;

    await storage.updateAudit(req.params.id, updates as any);
    const updated = await storage.getAudit(req.params.id);
    res.json({
      ...updated,
      intakeData: updated?.intakeData ? JSON.parse(updated.intakeData) : null,
      vendastaData: updated?.vendastaData ? JSON.parse(updated.vendastaData) : null,
      keysearchData: updated?.keysearchData ? JSON.parse(updated.keysearchData) : null,
      reportData: updated?.reportData ? JSON.parse(updated.reportData) : null,
    });
  });

  /* Retry a failed audit — resumes from the report-generation step using
     previously parsed/extracted data already stored on the audit row. */
  app.post("/api/audits/:id/retry", async (req, res) => {
    const audit = await storage.getAudit(req.params.id);
    if (!audit) return res.status(404).json({ message: "Audit not found" });
    if (audit.status === "processing") {
      return res.status(409).json({ message: "Audit is already processing" });
    }
    if (!audit.intakeData || !vendastaData(audit)) {
      return res.status(400).json({
        message:
          "Cannot retry — the original parsed data is missing. Please start a new audit and re-upload the documents.",
      });
    }

    await storage.updateAudit(req.params.id, {
      status: "processing",
      errorMessage: null as unknown as string,
    });

    retryAudit(req.params.id).catch(async (err) => {
      console.error("Audit retry error:", err);
      await storage.updateAudit(req.params.id, {
        status: "failed",
        errorMessage: err?.message || String(err),
      });
    });

    res.status(202).json({ id: req.params.id });
  });

  /* ----- Keysearch integration -----
     Step 1: user clicks "Pull Keysearch Data" on the report. We persist the URL
     they paste so the assistant (chat) can pick it up via browser automation. */
  app.post("/api/audits/:id/keysearch-pull", async (req, res) => {
    const audit = await storage.getAudit(req.params.id);
    if (!audit) return res.status(404).json({ message: "Audit not found" });
    const keysearchUrl = (req.body?.keysearchUrl || "").trim();
    if (!keysearchUrl) {
      return res.status(400).json({ message: "keysearchUrl is required" });
    }
    const intake = audit.intakeData ? JSON.parse(audit.intakeData) : {};
    intake.keysearchPendingUrl = keysearchUrl;
    await storage.updateAudit(req.params.id, {
      intakeData: JSON.stringify(intake),
    });
    res.json({
      status: "pending",
      message:
        "Keysearch URL saved. The assistant will complete the pull from the conversation.",
    });
  });

  /* Direct Keysearch lookup — used by the New Audit form's "Auto-fetch" button.
     Server logs into Keysearch with stored credentials, scrapes the Explorer page
     for the given domain, and returns CSV-shaped JSON the client can attach to
     the audit submission alongside (or instead of) a Keysearch CSV upload.

     Returns 503 if the feature flag is off or credentials are missing.
     Returns 502 if the scraper fails (login blocked, rate-limited, page changed). */
  app.post("/api/keysearch/lookup", async (req, res) => {
    try {
      if (!isKeysearchAutofetchEnabled()) {
        return res.status(503).json({
          message:
            "Keysearch auto-fetch is not configured on this server. Upload a CSV instead.",
        });
      }
      const rawDomain = (req.body?.domain || "").toString().trim();
      if (!rawDomain) {
        return res.status(400).json({ message: "domain is required" });
      }
      // Strip protocol + path, keep host only — Keysearch wants bare domains.
      let domain = rawDomain;
      try {
        if (domain.includes("://")) {
          const u = new URL(domain);
          domain = u.hostname;
        }
      } catch {
        /* fall through with the raw value */
      }
      domain = domain.replace(/^www\./i, "").split("/")[0];

      let data;
      try {
        data = await fetchKeysearchExplorer(domain);
      } catch (err: any) {
        if (err instanceof KeysearchScrapeError) {
          console.error(
            `keysearch lookup failed at step=${err.step}: ${err.message}` +
              (err.detail ? ` detail=${err.detail.slice(0, 200)}` : "") +
              (err.pageUrl ? ` pageUrl=${err.pageUrl}` : ""),
          );
          return res.status(502).json({
            step: err.step,
            message: err.message,
            detail: err.detail,
            pageUrl: err.pageUrl,
            screenshotPath: err.screenshotPath
              ? basename(err.screenshotPath)
              : undefined,
          });
        }
        throw err;
      }
      if (!data) {
        return res.status(503).json({
          step: "config",
          message:
            "Keysearch auto-fetch is disabled or missing credentials on the server.",
        });
      }
      const rows = explorerToKeywordRows(data);
      res.json({
        domain: data.domain,
        rows,
        summary: {
          domainStrength: data.domainStrength,
          backlinks: data.backlinks?.total ?? null,
          referringDomains: data.referringDomains?.total ?? null,
          organicKeywords: data.organicKeywords?.count ?? null,
          estTraffic: (data.organicKeywords as any)?.estTraffic ?? null,
          topCompetitorCount: data.topCompetitors?.length ?? 0,
        },
        explorer: data, // full payload kept so the frontend can echo a preview
      });
    } catch (err: any) {
      console.error("keysearch lookup error:", err);
      res.status(500).json({ message: err?.message || "Keysearch lookup failed" });
    }
  });

  /* Stream the most recent Keysearch debug screenshot (or one by filename).
     Used by NewAudit's auto-fetch error toast to show what Keysearch actually
     showed when the scraper got stuck. Auth-protected by the /api middleware.
     Note: registered as two routes because Express 5 / path-to-regexp v8
     removed the `?` optional-param shorthand. */
  function streamDebugScreenshot(filename: string | undefined, res: Response) {
    const dataDir = process.env.DATA_DIR || process.cwd();
    let target: string | null = null;
    if (filename) {
      const safe = basename(filename);
      if (!/^keysearch-debug-[a-z0-9-]+-\d+\.png$/i.test(safe)) {
        res.status(400).json({ message: "Invalid filename" });
        return;
      }
      const candidate = join(dataDir, safe);
      if (existsSync(candidate)) target = candidate;
    } else {
      try {
        const files = readdirSync(dataDir)
          .filter((f) => /^keysearch-debug-.+\.png$/i.test(f))
          .map((f) => ({ f, t: statSync(join(dataDir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        if (files.length > 0) target = join(dataDir, files[0].f);
      } catch (err) {
        console.error("debug-screenshot listing error:", err);
      }
    }
    if (!target) {
      res.status(404).json({ message: "No debug screenshot available" });
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    createReadStream(target).pipe(res);
  }
  app.get("/api/keysearch/debug-screenshot", (_req, res) => {
    streamDebugScreenshot(undefined, res);
  });
  app.get("/api/keysearch/debug-screenshot/:filename", (req, res) => {
    streamDebugScreenshot(req.params.filename, res);
  });

  /* Step 2: assistant POSTs extracted Keysearch metrics here. Merged into the
     SEO pillar so the report reflects domain authority, backlinks, and keywords. */
  app.post("/api/audits/:id/keysearch-data", async (req, res) => {
    const audit = await storage.getAudit(req.params.id);
    if (!audit) return res.status(404).json({ message: "Audit not found" });
    if (!audit.reportData) {
      return res.status(400).json({ message: "Audit has no report yet" });
    }

    const body = req.body || {};
    const report = JSON.parse(audit.reportData);
    report.seoDeep = report.seoDeep || {};

    if (typeof body.domainAuthority === "number") {
      report.seoDeep.domainAuthority = body.domainAuthority;
    }
    if (typeof body.pageAuthority === "number") {
      report.seoDeep.pageAuthority = body.pageAuthority;
    }
    if (typeof body.backlinks === "number") {
      report.seoDeep.totalBacklinks = body.backlinks;
    }
    if (typeof body.referringDomains === "number") {
      report.seoDeep.referringDomains = body.referringDomains;
    }
    if (Array.isArray(body.topKeywords)) {
      const incoming = body.topKeywords
        .filter((k: any) => k && typeof k.keyword === "string")
        .map((k: any) => ({
          keyword: String(k.keyword),
          position: typeof k.position === "number" ? k.position : undefined,
          volume: typeof k.volume === "number" ? k.volume : undefined,
        }));
      const existing = Array.isArray(report.seoDeep.rankingKeywords)
        ? report.seoDeep.rankingKeywords
        : [];
      // Merge: incoming wins on duplicate keyword (case-insensitive)
      const map = new Map<string, any>();
      for (const k of existing) {
        if (k && k.keyword) map.set(String(k.keyword).toLowerCase(), k);
      }
      for (const k of incoming) {
        map.set(k.keyword.toLowerCase(), { ...map.get(k.keyword.toLowerCase()), ...k });
      }
      report.seoDeep.rankingKeywords = Array.from(map.values()).sort(
        (a: any, b: any) => (a.position ?? 999) - (b.position ?? 999)
      );
    }
    if (typeof body.napConsistency === "number") {
      report.seoDeep.napConsistency = report.seoDeep.napConsistency || { score: 0 };
      report.seoDeep.napConsistency.score = body.napConsistency;
    }

    // Site Audit metrics from Keysearch Site Audit (separate from Explorer fields).
    const siteAuditFields = [
      "optimizationScore",
      "totalIssues",
      "highIssues",
      "mediumIssues",
      "lowIssues",
      "pagesIndexed",
    ] as const;
    const hasSiteAudit = siteAuditFields.some(
      (f) => typeof body[f] === "number"
    );
    if (hasSiteAudit) {
      report.seoDeep.siteAudit = report.seoDeep.siteAudit || {};
      for (const f of siteAuditFields) {
        if (typeof body[f] === "number") {
          report.seoDeep.siteAudit[f] = body[f];
        }
      }
    }

    // Mark the SEO section as enriched so the UI shows a badge.
    report.pillars = report.pillars || {};
    report.pillars.seoListings = report.pillars.seoListings || {};
    report.pillars.seoListings.keysearchEnriched = true;

    // Clear pending URL since the pull completed
    const intake = audit.intakeData ? JSON.parse(audit.intakeData) : {};
    delete intake.keysearchPendingUrl;
    intake.keysearchEnrichedAt = Date.now();

    await storage.updateAudit(req.params.id, {
      reportData: JSON.stringify(report),
      intakeData: JSON.stringify(intake),
    });

    res.json({ status: "ok", message: "Keysearch data merged into audit." });
  });

  /* ----- Final Manus deliverable upload -----
     User uploads the simplified PDF Manus produced; we save it to disk and
     stamp the audit row. The actual merge/PPTX work happens in the assistant. */
  const finalUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (FINAL_PDF_MIMES.has(file.mimetype)) cb(null, true);
      else cb(new Error(`Final deliverable must be PDF, got: ${file.mimetype}`));
    },
  });
  app.post(
    "/api/audits/:id/final-deliverable",
    finalUpload.single("manusPdf"),
    async (req, res) => {
      try {
        const audit = await storage.getAudit(req.params.id);
        if (!audit) return res.status(404).json({ message: "Audit not found" });
        const file = (req as any).file as Express.Multer.File | undefined;
        if (!file) return res.status(400).json({ message: "manusPdf file is required" });
        const format = (req.body?.format || "merged-pdf").toString();

        const uploadsDir = process.env.UPLOADS_DIR
          || (process.env.DATA_DIR ? join(process.env.DATA_DIR, "uploads") : "/home/user/workspace/smb-audit-engine/uploads");
        mkdirSync(uploadsDir, { recursive: true });
        const filePath = join(uploadsDir, `manus-${req.params.id}.pdf`);
        writeFileSync(filePath, file.buffer);

        const intake = audit.intakeData ? JSON.parse(audit.intakeData) : {};
        intake.manusPdfPath = filePath;
        intake.finalDeliverableFormat = format;
        intake.manusPdfUploadedAt = Date.now();
        await storage.updateAudit(req.params.id, {
          intakeData: JSON.stringify(intake),
        });

        res.json({
          status: "received",
          message: "Manus PDF saved. You can download it any time from this page.",
          format,
          uploadedAt: intake.manusPdfUploadedAt,
        });
      } catch (err: any) {
        console.error("final-deliverable error:", err);
        res.status(500).json({ message: err?.message || "Upload failed" });
      }
    }
  );

  /* Generate the ElevenLabs DJ #2 narration script from the Manus PDF.
     Returns a plain-text .txt download ready to paste into ElevenLabs. */
  app.get("/api/audits/:id/elevenlabs-script", async (req, res) => {
    try {
      const audit = await storage.getAudit(req.params.id);
      if (!audit) return res.status(404).json({ message: "Audit not found" });
      const intake = audit.intakeData ? JSON.parse(audit.intakeData) : {};
      const filePath: string | undefined = intake.manusPdfPath;
      if (!filePath || !existsSync(filePath)) {
        return res.status(404).json({
          message: "Upload the Manus PDF first \u2014 the script is generated from it.",
        });
      }

      const { generateElevenLabsScript } = await import("./elevenlabs-narration");
      const script = await generateElevenLabsScript({
        pdfPath: filePath,
        context: {
          ownerName: intake.contactName || intake.clientName || audit.clientName,
          businessName: audit.clientName || intake.clientName,
          industry: audit.industry ?? undefined,
          location: audit.location ?? undefined,
          overallGrade: audit.overallGrade ?? null,
          overallScore: audit.overallScore ?? null,
        },
      });

      const slug = (audit.clientName || "audit")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "audit";
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${slug}-elevenlabs-dj2-script.txt"`,
      );
      res.send(script);
    } catch (err: any) {
      console.error("elevenlabs-script error:", err);
      res.status(500).json({ message: err?.message || "Script generation failed" });
    }
  });

  /* Download the previously uploaded Manus PDF for an audit */
  app.get("/api/audits/:id/manus-pdf", async (req, res) => {
    try {
      const audit = await storage.getAudit(req.params.id);
      if (!audit) return res.status(404).json({ message: "Audit not found" });
      const intake = audit.intakeData ? JSON.parse(audit.intakeData) : {};
      const filePath: string | undefined = intake.manusPdfPath;
      if (!filePath || !existsSync(filePath)) {
        return res.status(404).json({ message: "No Manus PDF uploaded for this audit yet." });
      }
      const slug = (audit.clientName || "audit")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "audit";
      const stat = statSync(filePath);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", stat.size.toString());
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${slug}-final-deliverable.pdf"`,
      );
      createReadStream(filePath).pipe(res);
    } catch (err: any) {
      console.error("manus-pdf download error:", err);
      res.status(500).json({ message: err?.message || "Download failed" });
    }
  });

  /* Create new audit — multipart upload, kicks off async processing */
  app.post(
    "/api/audits",
    upload.fields([
      { name: "intake", maxCount: 1 },
      { name: "vendasta", maxCount: 1 },
      { name: "keysearch", maxCount: 5 },
    ]),
    async (req: Request, res: Response) => {
      try {
        const files = req.files as Record<string, Express.Multer.File[]>;
        const intakeFile = files?.intake?.[0];
        const vendastaFile = files?.vendasta?.[0];
        const keysearchFiles = files?.keysearch || [];
        const website = (req.body.website || "").trim();
        const clientName = (req.body.clientName || "").trim() || "Unnamed Client";

        // Auto-fetched Keysearch rows arrive as a JSON string in the multipart body
        // when the user clicked "Auto-fetch from Keysearch" instead of (or alongside)
        // a CSV upload. Same shape as parseKeysearchCsv output.
        let prefetchedRows: KeywordRow[] = [];
        const prefetchedJson = (req.body.keysearchRows || "").toString();
        if (prefetchedJson) {
          try {
            const parsed = JSON.parse(prefetchedJson);
            if (Array.isArray(parsed)) {
              prefetchedRows = parsed.filter(
                (r) => r && typeof r.keyword === "string" && r.keyword.trim()
              );
            }
          } catch (err) {
            console.warn("Could not parse keysearchRows JSON:", err);
          }
        }

        if (!intakeFile || !vendastaFile || !website) {
          return res
            .status(400)
            .json({ message: "intake PDF, vendasta PDF, and website URL are required" });
        }

        const id = randomUUID();
        await storage.createAudit({
          id,
          clientName,
          clientWebsite: website,
          status: "processing",
        });

        // Kick off async processing — fire and forget
        processAudit(id, {
          intakeBuf: intakeFile.buffer,
          vendastaBuf: vendastaFile.buffer,
          keysearchTexts: keysearchFiles.map((f) => f.buffer.toString("utf8")),
          prefetchedKeysearchRows: prefetchedRows,
          clientName,
          website,
        }).catch(async (err) => {
          console.error("Audit processing error:", err);
          await storage.updateAudit(id, {
            status: "failed",
            errorMessage: err?.message || String(err),
          });
        });

        res.status(202).json({ id });
      } catch (err: any) {
        console.error(err);
        res.status(500).json({ message: err?.message || "Upload failed" });
      }
    }
  );

  return httpServer;
}

async function processAudit(
  id: string,
  args: {
    intakeBuf: Buffer;
    vendastaBuf: Buffer;
    keysearchTexts: string[];
    prefetchedKeysearchRows?: KeywordRow[];
    clientName: string;
    website: string;
  }
) {
  // Step 1: parse PDFs
  const [intakeText, vendastaText] = await Promise.all([
    parsePdfBuffer(args.intakeBuf),
    parsePdfBuffer(args.vendastaBuf),
  ]);

  // Step 2: parse Keysearch CSVs + merge with any auto-fetched rows.
  // Dedup on lowercased keyword; CSV wins on conflict (it has full columns).
  const csvRows: KeywordRow[] = args.keysearchTexts
    .flatMap((csv) => parseKeysearchCsv(csv))
    .filter((r) => !!r.keyword);
  const merged = new Map<string, KeywordRow>();
  for (const r of args.prefetchedKeysearchRows || []) {
    if (r?.keyword) merged.set(r.keyword.toLowerCase(), r);
  }
  for (const r of csvRows) {
    if (r?.keyword) merged.set(r.keyword.toLowerCase(), r);
  }
  const keysearch: KeywordRow[] = Array.from(merged.values());

  // Step 3: extract structured data via AI (parallel)
  const [intake, vendasta] = await Promise.all([
    extractIntake(intakeText),
    extractVendasta(vendastaText),
  ]);

  await storage.updateAudit(id, {
    intakeData: JSON.stringify(intake),
    vendastaData: JSON.stringify(vendasta),
    keysearchData: JSON.stringify(keysearch),
    industry: intake.industry,
    location: intake.location,
    clientName: intake.clientName || args.clientName,
  });

  // Step 4: generate full report
  const report = await generateReport({
    clientName: intake.clientName || args.clientName,
    website: args.website,
    intake,
    vendasta,
    keysearch,
  });

  await storage.updateAudit(id, {
    reportData: JSON.stringify(report),
    overallGrade: report.overallGrade as Grade,
    overallScore: report.overallScore,
    status: "complete",
  });
}

/** Type-narrowing helper so TS is happy when checking that vendastaData exists. */
function vendastaData(audit: { vendastaData?: string | null }): string | null | undefined {
  return audit.vendastaData;
}

/** Resume processing from the report-generation step using stored intake/vendasta/keysearch data. */
async function retryAudit(id: string) {
  const audit = await storage.getAudit(id);
  if (!audit) throw new Error("Audit row vanished mid-retry");

  const intake = JSON.parse(audit.intakeData || "{}") as IntakeData;
  const vendasta = JSON.parse(audit.vendastaData || "{}") as VendastaData;
  const keysearch = JSON.parse(audit.keysearchData || "[]") as KeywordRow[];

  const clientName = intake.clientName || audit.clientName;
  const website = audit.clientWebsite;

  const report = await generateReport({ clientName, website, intake, vendasta, keysearch });

  await storage.updateAudit(id, {
    reportData: JSON.stringify(report),
    overallGrade: report.overallGrade as Grade,
    overallScore: report.overallScore,
    status: "complete",
    errorMessage: null as unknown as string,
  });
}
