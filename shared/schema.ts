import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

/**
 * Audits — one row per generated audit report.
 * Most rich data is stored as JSON text columns since SQLite has no native arrays/objects.
 */
export const audits = sqliteTable("audits", {
  id: text("id").primaryKey(), // uuid
  clientName: text("client_name").notNull(),
  clientWebsite: text("client_website").notNull(),
  industry: text("industry"),
  location: text("location"),
  status: text("status").notNull().default("processing"), // processing | complete | failed
  overallGrade: text("overall_grade"), // A, B+, C, D, F
  overallScore: integer("overall_score"), // 0-100
  // JSON blobs
  intakeData: text("intake_data"),     // extracted intake form data
  vendastaData: text("vendasta_data"), // extracted snapshot data
  keysearchData: text("keysearch_data"), // parsed CSV rows
  reportData: text("report_data"),     // full structured report (pillars, plan, summary)
  voiceoverScript: text("voiceover_script"),
  errorMessage: text("error_message"),
  delivered: integer("delivered").notNull().default(0), // 0 = ready, 1 = delivered
  createdAt: integer("created_at").notNull(),
});

export const insertAuditSchema = createInsertSchema(audits).omit({
  createdAt: true,
});

export type InsertAudit = z.infer<typeof insertAuditSchema>;
export type Audit = typeof audits.$inferSelect;

/* ---------- Strongly typed report shapes (used on the frontend) ---------- */

export const grades = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "F"] as const;
export type Grade = typeof grades[number];

export interface PillarReport {
  name: string;
  grade: Grade;
  score: number; // 0-100
  summary: string;
  strengths: string[];
  gaps: string[];
  recommendations: string[];
}

/** AI assistant presence — is the business discoverable / cited / answered by each major AI? */
export interface AiPlatformPresence {
  platform: "ChatGPT" | "Google Gemini" | "Perplexity" | "Grok" | "Microsoft Copilot" | "Claude";
  present: boolean; // Does the AI surface them when asked about their category in their market?
  notes?: string;   // Plain-English explanation, e.g. "Not cited when asked for HVAC contractors in Macon, GA."
}

/** AI Automation pillar gets an extra structured field on top of the standard pillar shape. */
export interface AiAutomationPillar extends PillarReport {
  platforms: AiPlatformPresence[];
}

export type GeoLayer = "local" | "adjacent" | "metro" | "state" | "root" | "none";

/**
 * Strategic tier for narration. Drives the Brand → Local → National story
 * arc Dwayne wants in the audit voiceover:
 *   - brand: ranking for the business's own name or domain (limited reach)
 *   - local: high-intent searches in the client's city / metro (real opportunity)
 *   - national: large volume but geographically broad (long-term reach)
 */
export type KeywordTier = "brand" | "local" | "national";

export interface KeywordRow {
  keyword: string;
  position?: number;
  volume?: number;
  difficulty?: number;
  cpc?: number;
  competition?: number;  // 0..1 Google Ads competition index
  intent?: string;
  url?: string;
  geoLayer?: GeoLayer;   // Which geo layer produced the displayed volume
  volumeGeo?: string;    // Human-readable label, e.g. "Frisco, TX" or "Dallas Metro"
  tier?: KeywordTier;    // Brand / Local / National classification for narration
}

export interface ListingRow {
  directory: string;
  status: "Listed" | "Missing" | "Inconsistent";
  napAccurate?: boolean;
  notes?: string;
}

export interface SeoDeepDive {
  domainAuthority?: number;
  pageAuthority?: number;
  totalBacklinks?: number;
  referringDomains?: number;
  rankingKeywords: KeywordRow[];
  opportunityKeywords: KeywordRow[];
  listings: ListingRow[];
  napConsistency: {
    score: number; // 0-100
    nameVariants?: string[];
    addressVariants?: string[];
    phoneVariants?: string[];
    notes?: string;
  };
  siteAudit?: {
    optimizationScore?: number; // 0-100
    totalIssues?: number;
    highIssues?: number;
    mediumIssues?: number;
    lowIssues?: number;
    pagesIndexed?: number;
  };
}

/**
 * Core Web Vitals — each metric carries its raw value plus a plain-English
 * spelled-out name and explanation, so the voiceover can read them aloud.
 */
export interface CoreWebVital {
  value?: string;            // e.g. "2.8s" or "0.12"
  rating?: "Good" | "Needs Improvement" | "Poor";
  fullName: string;          // e.g. "Largest Contentful Paint"
  plainEnglish: string;      // e.g. "How long visitors wait before the main content appears"
}

export interface WebsitePerformance {
  performanceScore?: number;
  mobileScore?: number;
  accessibilityScore?: number;
  seoScore?: number;
  coreWebVitals: {
    lcp?: CoreWebVital;
    cls?: CoreWebVital;
    fid?: CoreWebVital;
  };
  conversionBlockers: string[];
  securityNotes: string[];
}

/**
 * Immediate Action Plan — NO 90-day horizon, NO paid-ad recommendations.
 * Just a short, prioritized list of things they (or we) can start on now,
 * grouped by the four pillars + a final "quick wins" bucket.
 */
export interface ImmediateActionItem {
  task: string;
  why: string;       // One-line reason why this matters
  priority: "Critical" | "High" | "Medium";
}

export interface ImmediateActionPlan {
  summary: string;   // 2–3 sentences re-stating the diagnosis in action terms
  aiAutomation: ImmediateActionItem[];
  seoListings: ImmediateActionItem[];
  reputation: ImmediateActionItem[];
  socialMedia: ImmediateActionItem[];
  quickWins: ImmediateActionItem[]; // Cross-pillar items they can knock out fast
  expectedOutcomes: string[];       // What "better" looks like once these are done
}

/**
 * Live-Google verified facts that always override conflicting snapshot data.
 * Populated by server/live-google-validation.ts before the audit narrative
 * is generated. When present, downstream code MUST trust these over Vendasta.
 */
export interface LiveValidation {
  gbp: {
    present: boolean;
    rating: number | null;
    reviewCount: number | null;
    phone: string | null;
    address: string | null;
    reviewsUrl: string | null;
  };
  social: {
    platform: "facebook" | "instagram" | "linkedin" | "tiktok" | "youtube";
    present: boolean;
    url: string | null;
  }[];
  /** Human-readable diff between snapshot and live data, for our records. */
  discrepancies: string[];
  /** Which provider answered ("dataforseo" | "serper" | "none"). */
  provider: string;
}

export interface ReportData {
  executiveSummary: {
    diagnosis: string;
    topWins: string[];
    topRisks: string[];
  };
  pillars: {
    aiAutomation: AiAutomationPillar;
    seoListings: PillarReport;
    reputation: PillarReport;
    socialMedia: PillarReport;
  };
  seoDeep: SeoDeepDive;
  websitePerformance: WebsitePerformance;
  immediateActionPlan: ImmediateActionPlan;
  /** Optional live-Google verified facts. When absent, snapshot data stands. */
  liveValidation?: LiveValidation;
}
