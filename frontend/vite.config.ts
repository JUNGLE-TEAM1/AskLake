import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  define: {
    "process.env.DRAGGABLE_DEBUG": "false",
  },
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        changeOrigin: true,
        target: "http://127.0.0.1:8080",
      },
    },
  },
});
