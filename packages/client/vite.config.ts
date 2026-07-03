import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // @collab/shared compiles to CommonJS (so the Node server can
      // `require()` it); Rollup's production build doesn't reliably infer
      // named exports from that CJS output for a workspace package
      // resolved outside node_modules' usual layout. Since the shared
      // package is pure, dependency-free TypeScript, it's simplest (and a
      // common monorepo pattern) to just point the client bundler at the
      // TS source directly -- Vite/esbuild transpiles it like any other
      // source file, with no CJS interop involved at all.
      "@collab/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
  },
});
