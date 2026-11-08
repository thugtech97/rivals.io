import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    host: true, // reachable from other devices on your network
    fs: { allow: [".."] }, // let the client import ../shared
  },
  build: {
    chunkSizeWarningLimit: 2000, // Phaser alone is ~1.5 MB minified (~400 KB gzipped)
  },
});
