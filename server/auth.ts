/**
 * Password-based authentication.
 *
 * Flow:
 *   1) POST /api/auth/login { email, password }
 *      - Verifies against users table
 *      - On success: sets a 30-day session JWT cookie, returns user info
 *      - On failure: 401
 *
 *   2) GET /api/auth/me
 *      - Returns { authEnabled, signedIn, email, role, mustChange }
 *
 *   3) POST /api/auth/change-password { currentPassword, newPassword }
 *      - Self-service password change. Required after first login when
 *        mustChange is true.
 *
 *   4) POST /api/auth/logout clears the cookie.
 *
 *   5) Admin-only routes (require role === "admin"):
 *        GET    /api/admin/users          list users
 *        POST   /api/admin/users          create user
 *        POST   /api/admin/users/:id/reset-password
 *        POST   /api/admin/users/:id/role
 *        DELETE /api/admin/users/:id
 *
 * Auth is bypassed entirely if AUTH_ENABLED !== "true". This keeps local
 * development frictionless while production stays locked down.
 */

import type { Express, Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import {
  createUser,
  deleteUser,
  getUserByEmail,
  getUserById,
  listUsers,
  markLoggedIn,
  setPassword,
  setRole,
  verifyPassword,
} from "./users";

const SESSION_COOKIE = "smb_session";
const SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

function getEnv() {
  const enabled = process.env.AUTH_ENABLED === "true";
  const secret = process.env.SESSION_SECRET || "";
  return { enabled, secret };
}

export interface SessionPayload {
  uid: string;
  email: string;
  role: "admin" | "member";
  kind: "session";
  iat?: number;
  exp?: number;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const { enabled, secret } = getEnv();
  if (!enabled) return next();
  if (!secret) {
    return res.status(500).json({ message: "Auth misconfigured: missing SESSION_SECRET" });
  }
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (!token) return res.status(401).json({ message: "Not signed in" });
  try {
    const payload = jwt.verify(token, secret) as SessionPayload;
    if (payload.kind !== "session") throw new Error("Wrong token kind");
    // Re-check that the user still exists and the role hasn't been revoked
    const row = getUserById(payload.uid);
    if (!row) return res.status(401).json({ message: "Account no longer exists" });
    (req as Request & { user?: SessionPayload }).user = {
      ...payload,
      role: row.role, // always serve fresh role
      email: row.email,
    };
    return next();
  } catch {
    return res.status(401).json({ message: "Session expired" });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const u = (req as Request & { user?: SessionPayload }).user;
    if (!u || u.role !== "admin") {
      return res.status(403).json({ message: "Admin only" });
    }
    next();
  });
}

function issueSessionCookie(res: Response, payload: Omit<SessionPayload, "iat" | "exp">) {
  const { secret } = getEnv();
  const token = jwt.sign(payload, secret, { expiresIn: SESSION_TTL_SEC });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SEC * 1000,
  });
}

export function registerAuthRoutes(app: Express) {
  /* ----------------------- public ----------------------- */

  app.get("/api/auth/me", (req: Request, res: Response) => {
    const { enabled, secret } = getEnv();
    if (!enabled) {
      return res.json({
        authEnabled: false,
        signedIn: true,
        email: null,
        role: "admin",
        mustChange: false,
      });
    }
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
    if (!token || !secret) {
      return res.json({
        authEnabled: true,
        signedIn: false,
        email: null,
        role: null,
        mustChange: false,
      });
    }
    try {
      const p = jwt.verify(token, secret) as SessionPayload;
      const row = getUserById(p.uid);
      if (!row) {
        return res.json({
          authEnabled: true,
          signedIn: false,
          email: null,
          role: null,
          mustChange: false,
        });
      }
      return res.json({
        authEnabled: true,
        signedIn: true,
        email: row.email,
        role: row.role,
        mustChange: row.must_change === 1,
      });
    } catch {
      return res.json({
        authEnabled: true,
        signedIn: false,
        email: null,
        role: null,
        mustChange: false,
      });
    }
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { enabled, secret } = getEnv();
    if (!enabled) return res.json({ ok: true });
    if (!secret) return res.status(500).json({ message: "Auth misconfigured" });

    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const user = await verifyPassword(email, password);
    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    markLoggedIn(user.id);
    issueSessionCookie(res, {
      uid: user.id,
      email: user.email,
      role: user.role,
      kind: "session",
    });

    return res.json({
      ok: true,
      user: {
        email: user.email,
        role: user.role,
        mustChange: user.must_change === 1,
      },
    });
  });

  app.post("/api/auth/logout", (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return res.json({ ok: true });
  });

  /* ----------------------- authed user ----------------------- */

  app.post("/api/auth/change-password", requireAuth, async (req: Request, res: Response) => {
    const u = (req as Request & { user?: SessionPayload }).user;
    if (!u) return res.status(401).json({ message: "Not signed in" });

    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Both current and new password are required" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ message: "New password must be at least 8 characters" });
    }

    const verified = await verifyPassword(u.email, currentPassword);
    if (!verified) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    try {
      await setPassword(u.id, newPassword, true);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(400).json({ message: err instanceof Error ? err.message : "Could not change password" });
    }
  });

  /* ----------------------- admin only ----------------------- */

  app.get("/api/admin/users", requireAdmin, (_req: Request, res: Response) => {
    return res.json({ users: listUsers() });
  });

  app.post("/api/admin/users", requireAdmin, async (req: Request, res: Response) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const role = req.body?.role === "admin" ? "admin" : "member";

    if (!email || !email.includes("@")) {
      return res.status(400).json({ message: "Valid email is required" });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }
    if (getUserByEmail(email)) {
      return res.status(409).json({ message: "A user with that email already exists" });
    }

    try {
      const user = await createUser({
        email,
        password,
        role,
        mustChange: true,
      });
      return res.json({ ok: true, user });
    } catch (err) {
      return res.status(400).json({ message: err instanceof Error ? err.message : "Could not create user" });
    }
  });

  app.post("/api/admin/users/:id/reset-password", requireAdmin, async (req: Request, res: Response) => {
    const id = req.params.id;
    const newPassword = String(req.body?.newPassword || "");
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ message: "New password must be at least 8 characters" });
    }
    const user = getUserById(id);
    if (!user) return res.status(404).json({ message: "User not found" });

    try {
      // forces must_change so the user is prompted to set their own password
      await setPassword(id, newPassword, false);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(400).json({ message: err instanceof Error ? err.message : "Could not reset password" });
    }
  });

  app.post("/api/admin/users/:id/role", requireAdmin, (req: Request, res: Response) => {
    const id = req.params.id;
    const role = req.body?.role === "admin" ? "admin" : "member";
    const user = getUserById(id);
    if (!user) return res.status(404).json({ message: "User not found" });
    setRole(id, role);
    return res.json({ ok: true });
  });

  app.delete("/api/admin/users/:id", requireAdmin, (req: Request, res: Response) => {
    const id = req.params.id;
    const me = (req as Request & { user?: SessionPayload }).user;
    if (me?.uid === id) {
      return res.status(400).json({ message: "You cannot delete your own account" });
    }
    const user = getUserById(id);
    if (!user) return res.status(404).json({ message: "User not found" });
    deleteUser(id);
    return res.json({ ok: true });
  });
}
