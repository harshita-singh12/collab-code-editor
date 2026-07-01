import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000,
    hookTimeout: 15000,
    globals: false,
    // These are integration tests sharing one real Postgres/Redis
    // instance (see README.md "Running the tests"). Running test files
    // in parallel would let concurrent TRUNCATEs and migrations race
    // against each other across files, so force sequential file
    // execution -- correctness over speed for a test suite this size.
    fileParallelism: false,
  },
});
