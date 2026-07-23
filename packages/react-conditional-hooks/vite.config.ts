import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["./src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    platform: "browser",
    sourcemap: false,
    minify: process.env.NODE_ENV === "production",
    deps: {
      neverBundle: ["bippy", "react"],
    },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.tsx"],
  },
});
