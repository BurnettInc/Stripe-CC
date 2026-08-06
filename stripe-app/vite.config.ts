import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      external: [
        '@stripe/ui-extension-sdk',
        '@stripe/ui-extension-sdk/ui',
        '@stripe/ui-extension-sdk/version',
      ],
    },
  },
});
