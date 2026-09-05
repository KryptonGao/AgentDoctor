import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/action/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  clean: true,
  outDir: "action-dist",
  outExtension: () => ({ js: ".mjs" }),
});
