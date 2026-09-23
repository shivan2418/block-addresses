import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  // Relative, so the same build works at a GitHub Pages project path (/block-addresses/).
  base: "./",
  plugins: [svelte()],
});
