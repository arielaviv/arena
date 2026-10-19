import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  server: { port: 5180 },
})
