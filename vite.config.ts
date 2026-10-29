import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the build works on GitHub Pages under any repo name.
  base: './',
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
