import { pool } from "../db/pool";
import { pruneSnapshots } from "../db/snapshotsRepo";

/**
 * Tombstone/metadata compaction for the *version history* table (the live
 * editing Y.Doc's own tombstone GC is automatic via Yjs's gc:true, so it
 * needs no code here). Run on a schedule (cron/k8s CronJob in production;
 * invoked manually here via `npm run compact-snapshots`).
 */
async function run() {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM documents");
  let totalDeleted = 0;
  for (const row of rows) {
    const deleted = await pruneSnapshots(row.id);
    totalDeleted += deleted;
    if (deleted > 0) {
      console.log(`[compact] document ${row.id}: pruned ${deleted} snapshot(s)`);
    }
  }
  console.log(`[compact] done, pruned ${totalDeleted} snapshot(s) across ${rows.length} document(s)`);
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch((err) => {
      console.error("[compact] failed", err);
      process.exitCode = 1;
      return pool.end();
    });
}

export { run as compactSnapshots };
