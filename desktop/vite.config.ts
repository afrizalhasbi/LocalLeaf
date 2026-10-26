import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// Electron loads either this dev server (ELECTRON_START_URL) or the built dist/ directly.
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/sidecar/**", "**/electron/**"] },
  },
  envPrefix: ["VITE_"],
  build: {
    target: "chrome120",
    chunkSizeWarningLimit: 4096,
  },
});
