import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 3767,
    proxy: {
      "/api": "http://127.0.0.1:3766"
    }
  },
  preview: {
    host: "127.0.0.1",
    port: 3768
  }
});
