import type { CharlieCodeApi } from '../shared/ipc'

declare global {
  interface Window {
    charliecode: CharlieCodeApi
  }
}

export {}
