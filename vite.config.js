import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: true,
    open: true
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 1500
  },
  optimizeDeps: {
    include: ['three']
  }
});
