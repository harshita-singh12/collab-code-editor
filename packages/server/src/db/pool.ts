import { Pool } from "pg";
import { env } from "../util/env";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

pool.on("error", (err) => {
  // Idle client errors should not crash the process; log and let the pool
  // recover the connection on next checkout.
  // eslint-disable-next-line no-console
  console.error("[postgres] unexpected idle client error", err);
});
