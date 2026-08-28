import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'
import pkg from './package.json'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [wasm()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: `${root}index.html`,
        admin: `${root}admin.html`,
      },
    },
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d'],
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
})
