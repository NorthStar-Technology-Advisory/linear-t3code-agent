import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

/** Synchronous SQLite transactions make intake durable before its HTTP acknowledgement. */
export class BridgeStore<T> {
  private readonly db: DatabaseSync;
  private readonly owner = randomUUID();
  constructor(file: string, fallback: T) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS bridge_state (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, body TEXT NOT NULL)");
    this.db.prepare("INSERT OR IGNORE INTO bridge_state VALUES (1, 1, ?)").run(JSON.stringify(fallback));
    this.db.exec("CREATE TABLE IF NOT EXISTS bridge_owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, owner TEXT NOT NULL)");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT pid FROM bridge_owner WHERE id=1").get();
      if (previous) {
        let alive = true;
        try { process.kill(Number(previous.pid), 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
        if (alive) throw new Error("Another bridge process owns this database. Run one bridge process per installation.");
      }
      this.db.prepare("INSERT OR REPLACE INTO bridge_owner VALUES (1, ?, ?)").run(process.pid, this.owner);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); this.db.close(); throw error; }
    const row = this.db.prepare("SELECT version FROM bridge_state WHERE id=1").get();
    if (row?.version !== 1) { this.db.close(); throw new Error("Unsupported bridge database version; restore a compatible bridge release."); }
  }
  read(): T {
    return JSON.parse(String(this.db.prepare("SELECT body FROM bridge_state WHERE id=1").get()!.body)) as T;
  }
  update<R>(change: (state: T) => R): R {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.read();
      const result = change(state);
      this.db.prepare("UPDATE bridge_state SET body=? WHERE id=1").run(JSON.stringify(state));
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close() { this.db.prepare("DELETE FROM bridge_owner WHERE owner=?").run(this.owner); this.db.close(); }
}
