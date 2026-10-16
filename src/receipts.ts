import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Separate from the retired bridge database: no old session is read, resumed or migrated.
export class Receipts {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 1000; CREATE TABLE IF NOT EXISTS deliveries (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)");
  }
  claim(digest: string, now: number): "claimed" | "delivered" | "busy" {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM deliveries WHERE expires_at <= ?").run(now);
      const existing = this.db.prepare("SELECT delivered FROM deliveries WHERE digest = ?").get(digest);
      if (existing) {
        this.db.exec("COMMIT");
        return existing.delivered ? "delivered" : "busy";
      }
      this.db.prepare("INSERT INTO deliveries (digest, expires_at) VALUES (?, ?)").run(digest, now + 10000);
      this.db.exec("COMMIT");
      return "claimed";
    } catch (error) {
      this.db.exec("ROLLBACK"); throw error;
    }
  }
  delivered(digest: string, now: number): void {
    this.db.prepare("UPDATE deliveries SET delivered = 1, expires_at = ? WHERE digest = ?").run(now + 7 * 86400000, digest);
  }
  release(digest: string): void { this.db.prepare("DELETE FROM deliveries WHERE digest = ? AND delivered = 0").run(digest); }
  close(): void { this.db.close(); }
}
