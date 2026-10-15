import { defineConfig, defaultClientConditions } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // In dev, workspace packages resolve to their TypeScript sources ("source"
  // export condition); production builds use the compiled dist from `tsc -b`.
  resolve: command === "serve" ? { conditions: ["source", ...defaultClientConditions] } : {},
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3080"
    }
  }
}));
