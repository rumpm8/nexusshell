/**
 * SQLite access via tauri-plugin-sql. Every helper is a no-op outside the
 * Tauri runtime (plain `vite dev` in a browser) so the UI is always runnable.
 */

let dbPromise: Promise<any> | null = null;

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function db() {
  if (!inTauri()) return null;
  if (!dbPromise) {
    dbPromise = import("@tauri-apps/plugin-sql").then((m) =>
      m.default.load("sqlite:nexus.db"),
    );
  }
  return dbPromise;
}

export async function logActivity(
  workerId: string,
  kind: string,
  description: string,
  ok: boolean,
  tokens: number,
  costUsd: number,
): Promise<void> {
  const d = await db();
  if (!d) return;
  await d.execute(
    `INSERT INTO activities (worker_id, kind, description, status, tokens_in, tokens_out, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [workerId, kind, description, ok ? "ok" : "fail", Math.floor(tokens / 2), Math.ceil(tokens / 2), costUsd],
  );
}

export async function logMetric(metric: string, value = 1): Promise<void> {
  const d = await db();
  if (!d) return;
  await d.execute(
    `INSERT INTO ingestion_metrics (metric, value) VALUES ($1, $2)`,
    [metric, value],
  );
}

/* ── studio tasks (rebuilt from the old NEXUS tasks module) ─────────────── */

export interface StudioTask {
  id: number;
  title: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  priority: "low" | "medium" | "high";
  tags: string;
  created: string;
  updated: string;
}

export async function tasksList(): Promise<StudioTask[]> {
  const d = await db();
  if (!d) return [];
  return d.select(
    `SELECT * FROM studio_tasks ORDER BY
       CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1
                   WHEN 'blocked' THEN 2 ELSE 3 END,
       CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
       created DESC
     LIMIT 200`);
}

export async function tasksAdd(title: string, priority: string): Promise<void> {
  const d = await db();
  if (!d) return;
  await d.execute(
    `INSERT INTO studio_tasks (title, priority) VALUES ($1, $2)`,
    [title, priority]);
}

export async function tasksSetStatus(id: number, status: string): Promise<void> {
  const d = await db();
  if (!d) return;
  await d.execute(
    `UPDATE studio_tasks SET status = $1, updated = datetime('now') WHERE id = $2`,
    [status, id]);
}

export async function tasksDelete(id: number): Promise<void> {
  const d = await db();
  if (!d) return;
  await d.execute(`DELETE FROM studio_tasks WHERE id = $1`, [id]);
}

export interface StoredTotals {
  activities: number;
  tokens: number;
  costUsd: number;
}

export async function fetchTotals(): Promise<StoredTotals | null> {
  const d = await db();
  if (!d) return null;
  const rows = await d.select(
    `SELECT COUNT(*) AS activities,
            COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
            COALESCE(SUM(cost_usd), 0) AS costUsd
     FROM activities`,
  );
  return rows[0] ?? null;
}
