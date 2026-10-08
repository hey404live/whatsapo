import { defineConfig } from 'vite';

export default defineConfig({
  preview: { proxy: { '/api': 'http://127.0.0.1:3000' } },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
