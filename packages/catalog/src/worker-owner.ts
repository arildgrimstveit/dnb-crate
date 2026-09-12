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

export function hasLiveWorker(db: SqliteDatabase): boolean {
  const owner = db.prepare("SELECT pid FROM worker_owner WHERE id = 1").get() as
    { pid: number } | undefined;
  return Boolean(owner && processIsAlive(owner.pid));
}

/** One local process owns background work for a catalog, across all job kinds.
 * Never expire a live process's ownership during a long synchronous DSP pass.
 */
export class WorkerOwner {
  private readonly token = crypto.randomUUID();
  private owned = false;

  constructor(private readonly db: SqliteDatabase) {}

  acquire(): boolean {
    if (this.owned) return true;
    this.owned = this.db
      .transaction(() => {
        const owner = this.db.prepare("SELECT pid FROM worker_owner WHERE id = 1").get() as
          { pid: number } | undefined;
        if (owner && processIsAlive(owner.pid)) return false;
        this.db
          .prepare("INSERT OR REPLACE INTO worker_owner (id, token, pid) VALUES (1, ?, ?)")
          .run(this.token, process.pid);
        return true;
      })
      .immediate();
    return this.owned;
  }

  release(): void {
    if (!this.owned) return;
    this.db.prepare("DELETE FROM worker_owner WHERE id = 1 AND token = ?").run(this.token);
    this.owned = false;
  }
}
