import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_");
  const devProxyTarget = environment.VITE_DEV_PROXY_TARGET || "http://127.0.0.1:8080";

  return {
    build: {
      assetsInlineLimit: 0,
    },
    clearScreen: false,
    define: {
      "process.env.DRAGGABLE_DEBUG": "false",
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        {
          find: "@",
          replacement: fileURLToPath(new URL("./src", import.meta.url)),
        },
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
          target: devProxyTarget,
        },
      },
      preTransformRequests: false,
      hmr: false,
      watch: {
        ignored: ["**/*"],
      },
    },
  };
});
