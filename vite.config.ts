import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages project site: https://<user>.github.io/<repo>/
// Keep dev server at "/" but build with the repo subpath.
export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : '/drons_dashboard_map/',
  plugins: [react()],
}));

