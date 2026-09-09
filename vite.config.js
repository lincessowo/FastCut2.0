import { defineConfig } from "vite";

import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        bili: resolve(__dirname, "bili-player.html"),
      },
    },
  },
});
