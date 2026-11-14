import type { AttachmentRef, EffortLevel, ToolLog } from './types'

/**
 * Pure data shapes for the transcript.
 *
 * They live apart from `sessions.ts` on purpose: the renderer and the preload
 * bridge type-check against them, and that project has no Node types. Anything
 * imported here must stay free of `node:*` imports.
 */

export type SessionRole = 'user' | 'assistant'

export interface StoredMessage {
  id: string
  role: SessionRole
  content: string
  createdAt: string
  /** Model that produced the text, when known. */
  modelKey?: string
  error?: string
  meta?: string
  /** Images and documents sent with this turn (metadata only). */
  attachments?: AttachmentRef[]
  /** Tools the model ran in this turn, with diffs and subagent activity. */
  tools?: ToolLog[]
}

export interface SessionHeader {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  workspacePath?: string
  modelKey?: string
  effort: EffortLevel
}

export interface SessionSummary extends SessionHeader {
  messageCount: number
  preview: string
}

export interface Session extends SessionHeader {
  messages: StoredMessage[]
}

export interface NewSessionInput {
  id?: string
  title?: string
  workspacePath?: string
  modelKey?: string
  effort?: EffortLevel
}

export interface SessionPatch {
  title?: string
  modelKey?: string
  effort?: EffortLevel
  workspacePath?: string
}
