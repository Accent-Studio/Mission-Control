import { defineConfig } from "vite";

// 1730/1731: the next pair after BlitzVoice Notes (1720/1721).
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1730,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1731 } : undefined,
  },
});
