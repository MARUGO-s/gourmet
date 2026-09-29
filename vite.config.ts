import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/gourmet/",
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // Keep the app chunk under Vite's 500 kB warning by splitting framework/vendor code.
        manualChunks(id) {
          if (id.includes("node_modules")) return id.includes("@supabase") ? "supabase" : "vendor";
        },
      },
    },
  },
  server: {
    port: 5173,
    watch: {
      ignored: ["**/.env", "**/data/**"],
    },
  },
});
