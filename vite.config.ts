import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages friendly: relative asset paths.
export default defineConfig({
  base: './',
  plugins: [react()],
});

