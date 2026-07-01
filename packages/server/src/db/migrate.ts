import fs from "fs";
import path from "path";
import { pool } from "./pool";

/**
 * Minimal, dependency-free migration runner: applies every .sql file in
 * migrations/ in filename order, exactly once, tracked in
 * schema_migrations. Good enough for this project's scope; a real
 * production system would reach for something like node-pg-migrate, but
 * that's unnecessary weight here.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const dir = path.join(__dirname, "..", "..", "migrations");
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations"
    );
    const applied = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      console.log(`[migrate] applying ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    console.log("[migrate] up to date");
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error("[migrate] failed", err);
      process.exitCode = 1;
      return pool.end();
    });
}

export { migrate };
