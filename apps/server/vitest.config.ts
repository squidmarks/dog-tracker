import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Mongo-backed tests read MONGO_URL from the repo's .env.local (see scripts/dev-env.sh); without it they skip.
export default defineConfig(({ mode }) => ({
  test: { env: loadEnv(mode, "../..", ""), fileParallelism: false },
}));
