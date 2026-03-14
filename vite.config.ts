import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/boreal-web-viewer/",
  worker: { format: "es" },
  server: {
    port: 3000,
  },
});
