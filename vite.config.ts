import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), {
    name: 'record-build-assets',
    enforce: 'post',
    generateBundle(_, bundle) {
      this.emitFile({ type: 'asset', fileName: '.vite/build-assets.json', source: JSON.stringify(Object.keys(bundle)) });
    },
  }],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, manifest: true },
});
