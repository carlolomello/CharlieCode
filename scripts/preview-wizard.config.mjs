import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'scripts',
  plugins: [react()],
  build: {
    outDir: '.preview',
    emptyOutDir: true,
    rollupOptions: {
      input: ['scripts/preview-wizard.html', 'scripts/preview-panels.html']
    }
  }
})
