import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL ?? "https://unottr.pages.dev",
  output: "static",
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
  server: {
    allowedHosts: ["dev4321.nareshkhatri.dev"],
  },
});
