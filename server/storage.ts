import { audits } from '@shared/schema';
import type { Audit, AuditEvent, AuditEventType, InsertAudit } from '@shared/schema';
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// DATA_DIR points at a writable directory (Render persistent disk in prod, project root in dev).
const DATA_DIR = process.env.DATA_DIR || process.cwd();
mkdirSync(DATA_DIR, { recursive: true });
const sqlite = new Database(join(DATA_DIR, "data.db"));
sqlite.pragma("journal_mode = WAL");

// Ensure table exists (lightweight migration)
sqlite.exec(`
CREATE TABLE IF NOT EXISTS audits (
  id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  client_website TEXT NOT NULL,
  industry TEXT,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  overall_grade TEXT,
  overall_score INTEGER,
  intake_data TEXT,
  vendasta_data TEXT,
  keysearch_data TEXT,
  report_data TEXT,
  voiceover_script TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL
);
`);

// Lightweight column migrations for newer columns.
try {
  const cols = sqlite.prepare("PRAGMA table_info(audits)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("delivered")) {
    sqlite.exec("ALTER TABLE audits ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0;");
  }
  if (!names.has("edited_script")) {
    sqlite.exec("ALTER TABLE audits ADD COLUMN edited_script TEXT;");
  }
  if (!names.has("event_log")) {
    sqlite.exec("ALTER TABLE audits ADD COLUMN event_log TEXT;");
  }
} catch {
  /* noop */
}

export const db = drizzle(sqlite);

export interface IStorage {
  listAudits(): Promise<Audit[]>;
  getAudit(id: string): Promise<Audit | undefined>;
  createAudit(audit: InsertAudit): Promise<Audit>;
  updateAudit(id: string, patch: Partial<InsertAudit>): Promise<Audit | undefined>;
  deleteAudit(id: string): Promise<boolean>;
  appendEvent(
    id: string,
    type: AuditEventType,
    meta?: Record<string, unknown>,
  ): Promise<AuditEvent | undefined>;
}

export class DatabaseStorage implements IStorage {
  async listAudits(): Promise<Audit[]> {
    return db.select().from(audits).orderBy(desc(audits.createdAt)).all();
  }

  async getAudit(id: string): Promise<Audit | undefined> {
    return db.select().from(audits).where(eq(audits.id, id)).get();
  }

  async createAudit(insert: InsertAudit): Promise<Audit> {
    const row = { ...insert, createdAt: Date.now() };
    return db.insert(audits).values(row).returning().get();
  }

  async updateAudit(id: string, patch: Partial<InsertAudit>): Promise<Audit | undefined> {
    db.update(audits).set(patch).where(eq(audits.id, id)).run();
    return this.getAudit(id);
  }

  async deleteAudit(id: string): Promise<boolean> {
    const result = db.delete(audits).where(eq(audits.id, id)).run();
    return result.changes > 0;
  }

  async appendEvent(
    id: string,
    type: AuditEventType,
    meta?: Record<string, unknown>,
  ): Promise<AuditEvent | undefined> {
    const audit = await this.getAudit(id);
    if (!audit) return undefined;
    let events: AuditEvent[] = [];
    if (audit.eventLog) {
      try {
        const parsed = JSON.parse(audit.eventLog);
        if (Array.isArray(parsed)) events = parsed;
      } catch {
        /* corrupt log — start fresh */
      }
    }
    const event: AuditEvent = { type, at: Date.now(), meta };
    events.push(event);
    // Cap at 200 events so the column never grows unbounded for hot-reran audits.
    if (events.length > 200) events.splice(0, events.length - 200);
    db.update(audits).set({ eventLog: JSON.stringify(events) }).where(eq(audits.id, id)).run();
    return event;
  }
}

export const storage = new DatabaseStorage();
