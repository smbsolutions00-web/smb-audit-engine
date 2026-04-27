/**
 * SMB Solutions brand assets.
 *
 * Two variants are exposed:
 *   Logo               : full wordmark (cube + "SMB Solutions" + "A Division of Tsalach Inc")
 *   Logo variant=mark  : icon-only cube (for tight spaces, mobile, favicons)
 *
 * Source files (imported via Vite so paths survive deploy proxying):
 *   client/src/assets/brand/wordmark.png  (transparent background)
 *   client/src/assets/brand/mark.png      (transparent background)
 *
 * The "Audit Engine" lockup label is rendered alongside the wordmark to clarify
 * we are inside the internal audit tool, not the public SMB Solutions brand site.
 */

import wordmarkUrl from "@/assets/brand/wordmark.png";
import markUrl from "@/assets/brand/mark.png";

interface LogoProps {
  /** "wordmark" = full brand lockup (default). "mark" = icon-only cube. */
  variant?: "wordmark" | "mark";
  /** When true, the "Audit Engine" sublabel is hidden, useful for the report cover. */
  hideSublabel?: boolean;
  /** When true, label text uses currentColor so it works on dark backgrounds. */
  inverted?: boolean;
  /** Tailwind height class for the logo image. Defaults differ per variant. */
  className?: string;
}

export function Logo({
  variant = "wordmark",
  hideSublabel = false,
  inverted = false,
  className,
}: LogoProps) {
  if (variant === "mark") {
    return (
      <img
        src={markUrl}
        alt="SMB Solutions"
        className={className ?? "h-9 w-9 rounded-md object-contain"}
        data-testid="logo-mark"
      />
    );
  }

  return (
    <div className="flex items-center gap-3" data-testid="logo-wordmark">
      <img
        src={wordmarkUrl}
        alt="SMB Solutions, A Division of Tsalach Inc"
        className={className ?? "h-12 w-auto object-contain"}
      />
      {!hideSublabel && (
        <div
          className="hidden border-l border-border pl-3 leading-tight sm:block"
          aria-hidden="true"
        >
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: inverted ? "rgba(255,255,255,0.85)" : "#2DBE7E" }}
          >
            Audit Engine
          </div>
          <div
            className="text-[10px] uppercase tracking-[0.12em]"
            style={{ color: inverted ? "rgba(255,255,255,0.55)" : "hsl(var(--muted-foreground))" }}
          >
            Internal Tool
          </div>
        </div>
      )}
    </div>
  );
}
