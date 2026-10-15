import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript source, so bundle them; keep npm deps external.
  noExternal: [/^@ashniva\//],
  // These load data files from their own package at runtime, so they can't be bundled.
  external: ["pdfkit", "@aws-sdk/client-s3"],
  // Bundled CommonJS dependencies (pg, dotenv, …) still call require().
  banner: { js: "import { createRequire as __ashnivaRequire } from 'node:module'; const require = __ashnivaRequire(import.meta.url);" },
});
