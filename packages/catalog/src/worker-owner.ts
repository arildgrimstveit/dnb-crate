import type { SqliteDatabase } from "./db.ts";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission failures are not evidence that another worker is dead.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** How long a recorded owner's heartbeat may stay stale before another runtime
 * takes ownership even though the pid still looks alive. This covers the
 * pid-reuse wedge: an exited owner's pid recycled by an unrelated long-lived
 * process looks alive forever, but nothing refreshes the heartbeat. The window
 * is deliberately generous — a live owner in one long synchronous DSP pass
 * (whole-file decode + STFT) must never be expired mid-flight.
 */
export const WORKER_HEARTBEAT_STALE_MS = 5 * 60 * 1000;

const WORKER_HEARTBEAT_INTERVAL_MS = 1000;

function ownerIsViable(owner: { pid: number; heartbeat_at: string | null }): boolean {
  if (!processIsAlive(owner.pid)) return false;
  if (owner.heartbeat_at == null) {
    // Legacy row written before the heartbeat column existed; pid-only liveness.
    return true;
  }
  const age = Date.now() - Date.parse(owner.heartbeat_at);
  return Number.isFinite(age) && age >= 0 && age <= WORKER_HEARTBEAT_STALE_MS;
}

export function hasLiveWorker(db: SqliteDatabase): boolean {
  const owner = db.prepare("SELECT pid, heartbeat_at FROM worker_owner WHERE id = 1").get() as
    { pid: number; heartbeat_at: string | null } | undefined;
  return Boolean(owner && ownerIsViable(owner));
}

/** One local process owns background work for a catalog, across all job kinds.
 * Never expire a live process's ownership during a long synchronous DSP pass;
 * the heartbeat window (not lease expiry) is the only staleness check.
 */
export class WorkerOwner {
  private readonly token = crypto.randomUUID();
  private owned = false;
  private lastBeat = 0;

  constructor(private readonly db: SqliteDatabase) {}

  acquire(): boolean {
    if (this.owned) return true;
    this.owned = this.db
      .transaction(() => {
        const owner = this.db
          .prepare("SELECT pid, heartbeat_at FROM worker_owner WHERE id = 1")
          .get() as { pid: number; heartbeat_at: string | null } | undefined;
        if (owner && ownerIsViable(owner)) return false;
        this.db
          .prepare(
            "INSERT OR REPLACE INTO worker_owner (id, token, pid, heartbeat_at) VALUES (1, ?, ?, ?)",
          )
          .run(this.token, process.pid, new Date().toISOString());
        return true;
      })
      .immediate();
    return this.owned;
  }

  /** Refresh the ownership heartbeat. Throttled; safe to call from the polling
   * loop every tick. Token-scoped so a deposed owner cannot revive a row now
   * owned by another runtime.
   *
   * Fencing (repository review item 5): when the token-scoped update affects
   * no row, this owner has been deposed by a takeover — it clears its owned
   * flag and returns false so the caller stops claiming new work. The return
   * value must be honored by the polling loop; an in-flight synchronous job
   * still completes (SQLite serializes writers), but no further claims
   * happen under the lost token. */
  heartbeat(): boolean {
    if (!this.owned) return false;
    const now = Date.now();
    if (now - this.lastBeat < WORKER_HEARTBEAT_INTERVAL_MS) return true;
    this.lastBeat = now;
    const result = this.db
      .prepare("UPDATE worker_owner SET heartbeat_at = ? WHERE id = 1 AND token = ?")
      .run(new Date().toISOString(), this.token);
    if (result.changes === 0) {
      // Another runtime took over while this process was busy or paused:
      // everything this owner believed about exclusivity is void.
      this.owned = false;
      return false;
    }
    return true;
  }

  /** True while this owner still holds the row under its token. */
  stillOwned(): boolean {
    if (!this.owned) return false;
    const row = this.db.prepare("SELECT token FROM worker_owner WHERE id = 1").get() as
      { token: string } | undefined;
    if (!row || row.token !== this.token) {
      this.owned = false;
      return false;
    }
    return true;
  }

  release(): void {
    if (!this.owned) return;
    this.db.prepare("DELETE FROM worker_owner WHERE id = 1 AND token = ?").run(this.token);
    this.owned = false;
  }
}
