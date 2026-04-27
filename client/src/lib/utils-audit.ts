import type { Grade } from "@shared/schema";

export function gradeColor(grade?: string): string {
  if (!grade) return "hsl(var(--muted-foreground))";
  const letter = grade[0];
  switch (letter) {
    case "A":
      return "hsl(152 63% 46%)"; // accent green
    case "B":
      return "hsl(197 60% 45%)"; // calm blue
    case "C":
      return "hsl(38 92% 55%)"; // amber
    case "D":
    case "F":
      return "hsl(0 72% 55%)"; // red
    default:
      return "hsl(var(--muted-foreground))";
  }
}

export function gradeBg(grade?: string): string {
  if (!grade) return "hsl(var(--muted))";
  const letter = grade[0];
  switch (letter) {
    case "A":
      return "hsl(152 63% 46% / 0.12)";
    case "B":
      return "hsl(197 60% 45% / 0.12)";
    case "C":
      return "hsl(38 92% 55% / 0.14)";
    case "D":
    case "F":
      return "hsl(0 72% 55% / 0.14)";
    default:
      return "hsl(var(--muted))";
  }
}

/** GPA-style average grade across an array of letter grades (A+, B-, C, D, F, …). */
export function averageGrade(grades: (string | null | undefined)[]): string {
  const map: Record<string, number> = {
    "A+": 4.3, "A": 4.0, "A-": 3.7,
    "B+": 3.3, "B": 3.0, "B-": 2.7,
    "C+": 2.3, "C": 2.0, "C-": 1.7,
    "D+": 1.3, "D": 1.0, "D-": 0.7,
    "F": 0.0,
  };
  const values = grades.filter((g): g is string => !!g && g in map).map((g) => map[g]);
  if (values.length === 0) return "N/A";
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  if (avg >= 4.15) return "A+";
  if (avg >= 3.85) return "A";
  if (avg >= 3.5) return "A-";
  if (avg >= 3.15) return "B+";
  if (avg >= 2.85) return "B";
  if (avg >= 2.5) return "B-";
  if (avg >= 2.15) return "C+";
  if (avg >= 1.85) return "C";
  if (avg >= 1.5) return "C-";
  if (avg >= 1.15) return "D+";
  if (avg >= 0.85) return "D";
  if (avg >= 0.5) return "D-";
  return "F";
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatNumber(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 10000) return (n / 1000).toFixed(1) + "K";
  return Math.round(n).toLocaleString();
}

export function formatCurrency(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  return "$" + n.toFixed(2);
}

export type AuditSummary = {
  id: string;
  clientName: string;
  clientWebsite: string;
  industry?: string | null;
  location?: string | null;
  status: "processing" | "complete" | "failed";
  overallGrade?: string | null;
  overallScore?: number | null;
  delivered?: boolean;
  pillarGrades?: {
    aiAutomation?: string | null;
    seoListings?: string | null;
    reputation?: string | null;
    socialMedia?: string | null;
  };
  createdAt: number;
};
