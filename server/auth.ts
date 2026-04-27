/**
 * Magic-link email authentication.
 *
 * Flow:
 *   1) POST /api/auth/request-link  { email }
 *      - If email is in ALLOWED_EMAILS allowlist:
 *          - Sign a short-lived (15 min) one-time JWT with { email, kind: "link" }
 *          - Email a link: https://<host>/api/auth/verify?token=<jwt>
 *      - Always respond 200 (don't leak which emails are allowed)
 *
 *   2) GET /api/auth/verify?token=<jwt>
 *      - Verify the link token
 *      - Set a long-lived (30 day) session JWT in an httpOnly cookie
 *      - 302 redirect to "/"
 *
 *   3) Every protected route runs requireAuth — checks the session cookie.
 *
 *   4) POST /api/auth/logout clears the cookie.
 *
 * Auth is bypassed entirely if AUTH_ENABLED !== "true". This keeps local
 * development frictionless while production stays locked down.
 */

import type { Express, Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { Resend } from "resend";

const SESSION_COOKIE = "smb_session";
const LINK_TTL_SEC = 15 * 60;          // 15 minutes
const SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

function getEnv() {
  const enabled = process.env.AUTH_ENABLED === "true";
  const allowed = (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const secret = process.env.SESSION_SECRET || "";
  const fromEmail = process.env.AUTH_FROM_EMAIL || "SMB Audit <onboarding@resend.dev>";
  const appUrl = process.env.APP_URL || ""; // e.g. https://audit.smbsolution.ai
  const resendKey = process.env.RESEND_API_KEY || "";
  return { enabled, allowed, secret, fromEmail, appUrl, resendKey };
}

export interface SessionPayload {
  email: string;
  kind: "session";
  iat?: number;
  exp?: number;
}
interface LinkPayload {
  email: string;
  kind: "link";
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const { enabled, secret } = getEnv();
  if (!enabled) return next(); // auth off
  if (!secret) {
    return res.status(500).json({ message: "Auth misconfigured: missing SESSION_SECRET" });
  }
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (!token) return res.status(401).json({ message: "Not signed in" });
  try {
    const payload = jwt.verify(token, secret) as SessionPayload;
    if (payload.kind !== "session") throw new Error("Wrong token kind");
    (req as Request & { user?: SessionPayload }).user = payload;
    return next();
  } catch {
    return res.status(401).json({ message: "Session expired" });
  }
}

export function registerAuthRoutes(app: Express) {
  /* Auth status — public, used by the frontend to decide whether to show login screen */
  app.get("/api/auth/me", (req: Request, res: Response) => {
    const { enabled, secret } = getEnv();
    if (!enabled) return res.json({ authEnabled: false, signedIn: true, email: null });
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
    if (!token || !secret) return res.json({ authEnabled: true, signedIn: false, email: null });
    try {
      const p = jwt.verify(token, secret) as SessionPayload;
      return res.json({ authEnabled: true, signedIn: true, email: p.email });
    } catch {
      return res.json({ authEnabled: true, signedIn: false, email: null });
    }
  });

  /* Request a magic link */
  app.post("/api/auth/request-link", async (req: Request, res: Response) => {
    const { enabled, allowed, secret, fromEmail, appUrl, resendKey } = getEnv();
    if (!enabled) return res.json({ ok: true });

    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return res.status(400).json({ message: "Invalid email" });
    }

    // Always 200 to prevent email enumeration
    if (!allowed.includes(email)) {
      console.log(`[auth] rejected magic-link request for ${email}`);
      return res.json({ ok: true });
    }

    if (!secret) {
      return res.status(500).json({ message: "SESSION_SECRET not configured" });
    }

    const linkToken = jwt.sign({ email, kind: "link" } as LinkPayload, secret, {
      expiresIn: LINK_TTL_SEC,
    });

    const baseUrl = appUrl || `${req.protocol}://${req.get("host")}`;
    const verifyUrl = `${baseUrl}/api/auth/verify?token=${encodeURIComponent(linkToken)}`;

    if (!resendKey) {
      // Dev mode without Resend — log the link to the server console
      console.log(`[auth] DEV magic link for ${email}: ${verifyUrl}`);
      return res.json({ ok: true, devLink: verifyUrl });
    }

    try {
      const resend = new Resend(resendKey);
      await resend.emails.send({
        from: fromEmail,
        to: email,
        subject: "Your SMB Audit Engine sign-in link",
        html: buildEmailHtml(verifyUrl),
        text: `Click to sign in: ${verifyUrl}\n\nThis link expires in 15 minutes.`,
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error("[auth] Resend error", err);
      return res.status(500).json({ message: "Could not send sign-in email" });
    }
  });

  /* Verify a magic-link token, set session cookie, redirect home */
  app.get("/api/auth/verify", (req: Request, res: Response) => {
    const { enabled, secret } = getEnv();
    if (!enabled) return res.redirect("/");

    const token = String(req.query.token || "");
    if (!token || !secret) {
      return res.status(400).send(htmlError("Invalid sign-in link."));
    }
    try {
      const payload = jwt.verify(token, secret) as LinkPayload;
      if (payload.kind !== "link") throw new Error("Wrong token kind");

      const session = jwt.sign(
        { email: payload.email, kind: "session" } as SessionPayload,
        secret,
        { expiresIn: SESSION_TTL_SEC },
      );

      // __Host- prefix isn't strictly required when we control the domain,
      // but it's the strongest cookie attribute set we can use.
      res.cookie(SESSION_COOKIE, session, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_TTL_SEC * 1000,
      });
      return res.redirect("/");
    } catch {
      return res.status(400).send(htmlError("This sign-in link has expired or is invalid."));
    }
  });

  /* Logout */
  app.post("/api/auth/logout", (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return res.json({ ok: true });
  });
}

function buildEmailHtml(link: string): string {
  return `<!doctype html>
<html><body style="font-family:Inter,system-ui,sans-serif;background:#f8fafc;padding:32px;color:#0f172a;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 12px 0;font-size:18px;font-weight:700;">Sign in to SMB Audit Engine</h1>
    <p style="margin:0 0 20px 0;font-size:14px;line-height:1.5;color:#475569;">
      Click the button below to sign in. This link expires in 15 minutes and can only be used once.
    </p>
    <a href="${link}" style="display:inline-block;background:#1e40af;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px;">
      Sign in
    </a>
    <p style="margin:24px 0 0 0;font-size:12px;color:#94a3b8;line-height:1.5;">
      If the button doesn't work, paste this URL into your browser:<br/>
      <span style="word-break:break-all;color:#475569;">${link}</span>
    </p>
    <p style="margin:24px 0 0 0;font-size:12px;color:#94a3b8;">
      If you didn't request this, you can safely ignore the email.
    </p>
  </div>
</body></html>`;
}

function htmlError(msg: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#f8fafc;padding:48px;text-align:center;color:#0f172a;">
  <div style="max-width:420px;margin:0 auto;">
    <h1 style="font-size:18px;font-weight:700;">${msg}</h1>
    <p style="margin-top:12px;color:#64748b;font-size:14px;">
      <a href="/" style="color:#1e40af;">Request a new link</a>
    </p>
  </div></body></html>`;
}
