import { pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";

/** Truncates every app table so each test file starts from a clean slate.
 * Requires a real Postgres reachable at DATABASE_URL (see README.md
 * "Running the tests" for how to point this at a disposable container). */
export async function resetDb(): Promise<void> {
  await migrate();
  await pool.query(
    "TRUNCATE document_snapshots, document_permissions, documents, users, schema_migrations RESTART IDENTITY CASCADE"
  );
  await migrate();
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
