import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    // sql.js loads a wasm module; the default node environment is fine.
    environment: "node",
  },
});
