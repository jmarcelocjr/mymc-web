import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the build works on GitHub Pages under any repo name.
  base: './',
  // Three.js is most of the bundle (~200 KB gzipped); one chunk is fine for this app.
  build: { chunkSizeWarningLimit: 1000 },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
