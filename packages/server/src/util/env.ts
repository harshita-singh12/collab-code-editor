import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: parseInt(process.env.PORT ?? "4000", 10),
  DATABASE_URL: required(
    "DATABASE_URL",
    "postgres://collab:collab@localhost:5432/collab"
  ),
  REDIS_URL: required("REDIS_URL", "redis://localhost:6379"),
  JWT_SECRET: required(
    "JWT_SECRET",
    process.env.NODE_ENV === "test" ? "test-secret" : undefined
  ),
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  // Debounced persistence: write to Postgres this long after the last edit.
  PERSIST_DEBOUNCE_MS: parseInt(process.env.PERSIST_DEBOUNCE_MS ?? "3000", 10),
  // ...but never let a continuously-typing room go longer than this without
  // a durable write.
  PERSIST_MAX_INTERVAL_MS: parseInt(
    process.env.PERSIST_MAX_INTERVAL_MS ?? "30000",
    10
  ),
  // How often (ms of sustained activity) to also drop a version-history
  // checkpoint row, independent of the live-state debounce above.
  VERSION_CHECKPOINT_INTERVAL_MS: parseInt(
    process.env.VERSION_CHECKPOINT_INTERVAL_MS ?? "300000",
    10
  ),
};
