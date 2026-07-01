import { createApp } from "./app";
import { env } from "./util/env";
import { migrate } from "./db/migrate";
import { roomManager } from "./rooms/roomManager";
import { pool } from "./db/pool";

async function main() {
  await migrate();

  const { httpServer } = createApp();
  httpServer.listen(env.PORT, () => {
    console.log(`[server] listening on :${env.PORT} (${env.NODE_ENV})`);
  });

  async function shutdown(signal: string) {
    console.log(`[server] received ${signal}, flushing rooms and shutting down...`);
    try {
      await roomManager.flushAll();
    } catch (err) {
      console.error("[server] error flushing rooms", err);
    }
    httpServer.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    // Force-exit if graceful shutdown hangs.
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[server] fatal startup error", err);
  process.exit(1);
});
