import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '/home/megha/.labnote-dist/web',
    emptyOutDir: true,
  },
})
