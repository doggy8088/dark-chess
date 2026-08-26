import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'

export default defineConfig({
  plugins: [wasm()],
  build: {
    target: 'es2022',
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
