import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  clearScreen: false,
  define: {
    "process.env.DRAGGABLE_DEBUG": "false",
  },
  plugins: [],
  resolve: {
    alias: [
      {
        find: /^lucide-react$/,
        replacement: fileURLToPath(new URL("./src/vendor/lucide.ts", import.meta.url)),
      },
    ],
  },
  server: {
    preTransformRequests: false,
    hmr: false,
    watch: {
      ignored: ["**/*"],
    },
  },
});
