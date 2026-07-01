import { pool } from "./pool";

export interface SnapshotRow {
  id: string;
  document_id: string;
  seq: number;
  label: string | null;
  state: Buffer;
  text_excerpt: string;
  size_bytes: number;
  created_by: string | null;
  created_at: Date;
}

export async function nextSeq(documentId: string): Promise<number> {
  const res = await pool.query<{ max: number | null }>(
    "SELECT MAX(seq) AS max FROM document_snapshots WHERE document_id = $1",
    [documentId]
  );
  return (res.rows[0].max ?? 0) + 1;
}

export async function insertSnapshot(params: {
  documentId: string;
  label: string | null;
  state: Buffer;
  textExcerpt: string;
  createdBy: string | null;
}): Promise<SnapshotRow> {
  const seq = await nextSeq(params.documentId);
  const res = await pool.query<SnapshotRow>(
    `INSERT INTO document_snapshots
       (document_id, seq, label, state, text_excerpt, size_bytes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.documentId,
      seq,
      params.label,
      params.state,
      params.textExcerpt,
      params.state.byteLength,
      params.createdBy,
    ]
  );
  return res.rows[0];
}

export async function listSnapshots(documentId: string): Promise<
  Array<Omit<SnapshotRow, "state" | "text_excerpt">>
> {
  const res = await pool.query(
    `SELECT id, document_id, seq, label, size_bytes, created_by, created_at
     FROM document_snapshots
     WHERE document_id = $1
     ORDER BY seq DESC`,
    [documentId]
  );
  return res.rows;
}

export async function getSnapshot(id: string): Promise<SnapshotRow | null> {
  const res = await pool.query<SnapshotRow>(
    "SELECT * FROM document_snapshots WHERE id = $1",
    [id]
  );
  return res.rows[0] ?? null;
}

export async function getSnapshotBefore(
  documentId: string,
  seq: number
): Promise<SnapshotRow | null> {
  const res = await pool.query<SnapshotRow>(
    `SELECT * FROM document_snapshots
     WHERE document_id = $1 AND seq < $2
     ORDER BY seq DESC LIMIT 1`,
    [documentId, seq]
  );
  return res.rows[0] ?? null;
}

/** Compaction / GC: prune old snapshot rows per a keep-more-recent,
 * thin-out-older retention policy. See DESIGN.md "Tombstone compaction". */
export async function pruneSnapshots(documentId: string): Promise<number> {
  const res = await pool.query<{ id: string; created_at: Date; label: string | null }>(
    `SELECT id, created_at, label FROM document_snapshots
     WHERE document_id = $1 ORDER BY created_at ASC`,
    [documentId]
  );
  const rows = res.rows;
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const toDelete: string[] = [];

  // Bucket rows older than 24h: keep at most one per hour for the last
  // week, then at most one per day beyond that. Always keep labeled
  // (user-named) checkpoints and always keep the most recent row.
  const keptBuckets = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const isLatest = i === rows.length - 1;
    const age = now - row.created_at.getTime();
    if (isLatest || row.label) continue; // always keep
    if (age <= DAY) continue; // keep everything from the last 24h

    const bucketKey =
      age <= 7 * DAY
        ? `h:${Math.floor(row.created_at.getTime() / (60 * 60 * 1000))}`
        : `d:${Math.floor(row.created_at.getTime() / DAY)}`;

    if (keptBuckets.has(bucketKey)) {
      toDelete.push(row.id);
    } else {
      keptBuckets.add(bucketKey);
    }
  }

  if (toDelete.length === 0) return 0;
  await pool.query("DELETE FROM document_snapshots WHERE id = ANY($1::uuid[])", [
    toDelete,
  ]);
  return toDelete.length;
}
