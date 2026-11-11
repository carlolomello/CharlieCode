import type { CharlieApi } from '../shared/ipc'

declare global {
  interface Window {
    charlie: CharlieApi
  }
}

export {}
