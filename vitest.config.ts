import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * One runner for the whole monorepo, split into projects:
 *  - unit:        *.test.ts in packages and the API, no database or network
 *  - integration: *.int.test.ts against a real test database and Redis
 *  - web:         *.test.tsx / *.test.ts in apps/web, rendered in jsdom
 * The node:test suite in packages/connectors/src/platforms.test.ts still runs through that
 * package's own `test` script.
 */
const root = import.meta.dirname;
const ignore = ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/._*"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          root,
          include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "apps/api/src/**/*.test.ts", "apps/worker/src/**/*.test.ts"],
          // node:test suite, run by its package's own `test` script.
          exclude: [...ignore, "**/*.int.test.ts", "packages/connectors/src/platforms.test.ts"],
          environment: "node",
          setupFiles: [path.join(root, "test/setup/unit.ts")],
        },
      },
      {
        test: {
          name: "integration",
          root,
          include: ["**/*.int.test.ts"],
          exclude: ignore,
          environment: "node",
          globalSetup: [path.join(root, "test/setup/global-db.ts")],
          setupFiles: [path.join(root, "test/setup/integration.ts")],
          // One shared test database: files run one after another.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        resolve: { alias: { "@": path.join(root, "apps/web") } },
        esbuild: { jsx: "automatic" },
        test: {
          name: "web",
          root: path.join(root, "apps/web"),
          include: ["**/*.test.{ts,tsx}"],
          exclude: ignore,
          environment: "jsdom",
          // Threads start reliably on a busy machine; forks sometimes failed to spawn.
          pool: "threads",
          setupFiles: [path.join(root, "test/setup/web.ts")],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "lcov"],
      reportsDirectory: path.join(root, "coverage"),
      include: ["apps/*/src/**/*.{ts,tsx}", "apps/web/{app,components,lib}/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
      exclude: ["**/*.test.*", "**/generated/**", "**/._*", "**/*.d.ts"],
    },
  },
});
