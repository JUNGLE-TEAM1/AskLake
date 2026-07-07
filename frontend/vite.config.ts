import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  clearScreen: false,
  define: {
    "process.env.DRAGGABLE_DEBUG": "false",
  },
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^lucide-react$/,
        replacement: fileURLToPath(new URL("./src/vendor/lucide.ts", import.meta.url)),
      },
    ],
  },
  server: {
    proxy: {
      "/api": {
        changeOrigin: true,
        target: "http://127.0.0.1:8080",
      },
    },
    preTransformRequests: false,
    hmr: false,
    watch: {
      ignored: ["**/*"],
    },
  },
});
