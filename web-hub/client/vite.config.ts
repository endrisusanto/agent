import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:4000',
        ws: true
      },
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true
      }
    }
  }
});
