import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// Electron is provided by the runtime; node builtins are never bundled.
const nodeExternals = ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)]

// NOTE: `ai` and `@ai-sdk/*` are ESM-only. We deliberately do NOT use
// externalizeDepsPlugin for the main process so Rollup bundles them into the
// CJS output. If you add a dependency that must stay external (native module),
// add it to `nodeExternals` and make sure it ships in `files` of electron-builder.
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      // electron-vite 6 externalizes every dependency by default. `ai` and
      // `@ai-sdk/*` are ESM-only, so they must be bundled into the CJS main output.
      externalizeDeps: false,
      rollupOptions: {
        external: nodeExternals,
        output: { format: 'cjs', entryFileNames: 'index.js' },
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      externalizeDeps: false,
      rollupOptions: {
        external: nodeExternals,
        output: { format: 'cjs', entryFileNames: 'index.js' },
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    plugins: [react()]
  }
})
