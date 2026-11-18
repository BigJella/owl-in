import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Listen on the LAN so other devices can open http://<this-pc-ip>:5173
    host: true,
  },
});
