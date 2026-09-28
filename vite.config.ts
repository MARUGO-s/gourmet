import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/gourmet/",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    watch: {
      ignored: ["**/.env", "**/data/**"],
    },
  },
});
