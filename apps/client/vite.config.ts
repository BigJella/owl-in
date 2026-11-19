import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // The player site, and the admin panel (localhost:5173/admin.html, only works on the server's computer).
      input: { main: resolve(import.meta.dirname, "index.html"), admin: resolve(import.meta.dirname, "admin.html") },
    },
  },
  server: {
    port: 5173,
    // Listen on the LAN so other devices can open http://<this-pc-ip>:5173
    host: true,
  },
});
