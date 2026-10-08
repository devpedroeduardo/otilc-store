import { defineConfig } from 'vitest/config';
import path from 'node:path';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'] },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
});
