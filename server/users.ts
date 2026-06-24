/**
 * User accounts for the audit engine.
 *
 * Replaces the old magic-link allowlist with real email + password accounts.
 * All routes are admin-gated; the first admin is seeded from ADMIN_EMAIL on
 * boot. Passwords are hashed with bcrypt (10 rounds, pure JS so Render
 * deploys cleanly without native binaries).
 *
 * Schema:
 *   id                TEXT PRIMARY KEY (uuid)
 *   email             TEXT UNIQUE NOT NULL (lowercased)
 *   password_hash     TEXT NOT NULL
 *   role              TEXT NOT NULL DEFAULT 'member'  ('admin' | 'member')
 *   must_change       INTEGER NOT NULL DEFAULT 0      (0 | 1)
 *   created_at        INTEGER NOT NULL (unix seconds)
 *   last_login_at     INTEGER
 */

import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { join } from "path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const usersDb = new Database(join(DATA_DIR, "data.db"));
usersDb.pragma("journal_mode = WAL");

usersDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    must_change INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
`);

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: "admin" | "member";
  must_change: 0 | 1;
  created_at: number;
  last_login_at: number | null;
}

export interface PublicUser {
  id: string;
  email: string;
  role: "admin" | "member";
  mustChange: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

function toPublic(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    mustChange: row.must_change === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export function getUserByEmail(email: string): UserRow | null {
  const row = usersDb
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email.trim().toLowerCase()) as UserRow | undefined;
  return row || null;
}

export function getUserById(id: string): UserRow | null {
  const row = usersDb.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row || null;
}

export function listUsers(): PublicUser[] {
  const rows = usersDb
    .prepare("SELECT * FROM users ORDER BY created_at ASC")
    .all() as UserRow[];
  return rows.map(toPublic);
}

export function countUsers(): number {
  const r = usersDb.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
  return r.c;
}

export function countAdmins(): number {
  const r = usersDb
    .prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'")
    .get() as { c: number };
  return r.c;
}

export async function createUser(opts: {
  email: string;
  password: string;
  role?: "admin" | "member";
  mustChange?: boolean;
}): Promise<PublicUser> {
  const email = opts.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error("Invalid email");
  if (!opts.password || opts.password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  if (getUserByEmail(email)) throw new Error("A user with that email already exists");

  const hash = await bcrypt.hash(opts.password, 10);
  const row: UserRow = {
    id: randomUUID(),
    email,
    password_hash: hash,
    role: opts.role || "member",
    must_change: opts.mustChange ? 1 : 0,
    created_at: Math.floor(Date.now() / 1000),
    last_login_at: null,
  };
  usersDb
    .prepare(
      `INSERT INTO users (id, email, password_hash, role, must_change, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.email,
      row.password_hash,
      row.role,
      row.must_change,
      row.created_at,
      row.last_login_at,
    );
  return toPublic(row);
}

export async function verifyPassword(email: string, password: string): Promise<UserRow | null> {
  const user = getUserByEmail(email);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  return user;
}

export async function setPassword(userId: string, newPassword: string, clearMustChange = true) {
  if (!newPassword || newPassword.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const hash = await bcrypt.hash(newPassword, 10);
  usersDb
    .prepare("UPDATE users SET password_hash = ?, must_change = ? WHERE id = ?")
    .run(hash, clearMustChange ? 0 : 1, userId);
}

export function markLoggedIn(userId: string) {
  usersDb
    .prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
    .run(Math.floor(Date.now() / 1000), userId);
}

export function deleteUser(userId: string) {
  usersDb.prepare("DELETE FROM users WHERE id = ?").run(userId);
}

export function setRole(userId: string, role: "admin" | "member") {
  usersDb.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
}

/**
 * Seed the admin account on boot.
 *
 * Behavior:
 *   - If users table is empty AND ADMIN_EMAIL is set, create that user as
 *     admin with password from ADMIN_INITIAL_PASSWORD (or a random one
 *     printed to the server log if not set). must_change defaults to true so
 *     the first login forces a password change.
 *   - If users exist, do nothing.
 */
export async function seedAdminIfNeeded() {
  if (countUsers() > 0) return;

  // Prefer ADMIN_EMAIL; fall back to the first entry in the legacy
  // ALLOWED_EMAILS env var so the rollout doesn't lock anyone out if they
  // forgot to add the new var to Render.
  let adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (!adminEmail) {
    const legacy = (process.env.ALLOWED_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (legacy.length > 0) {
      adminEmail = legacy[0];
      console.warn(
        `[users] ADMIN_EMAIL not set, falling back to first ALLOWED_EMAILS entry: ${adminEmail}`,
      );
    }
  }
  if (!adminEmail) {
    console.warn(
      "[users] No users in DB and neither ADMIN_EMAIL nor ALLOWED_EMAILS is set. Set ADMIN_EMAIL and redeploy to seed an admin account.",
    );
    return;
  }

  let initialPassword = (process.env.ADMIN_INITIAL_PASSWORD || "").trim();
  let generated = false;
  if (!initialPassword || initialPassword.length < 8) {
    initialPassword = randomUUID().replace(/-/g, "").slice(0, 16);
    generated = true;
  }

  await createUser({
    email: adminEmail,
    password: initialPassword,
    role: "admin",
    mustChange: true,
  });

  console.log("====================================================");
  console.log("[users] Seeded admin account:");
  console.log(`        email:    ${adminEmail}`);
  if (generated) {
    console.log(`        password: ${initialPassword}    (CHANGE ON FIRST LOGIN)`);
    console.log("        (Save this password now. It will not be shown again.)");
  } else {
    console.log("        password: (taken from ADMIN_INITIAL_PASSWORD env var)");
  }
  console.log("====================================================");
}
