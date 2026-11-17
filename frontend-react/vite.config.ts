import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // The Go sidecar serves the built React assets under /static/ while the
  // application document itself stays on the authenticated loopback origin.
  base: "/static/",
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    strictPort: true,
    port: 1420,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
