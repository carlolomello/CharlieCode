import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { Platform } from './platform'
import type { AttachmentRef, ChatMessage, IncomingAttachment } from './types'

export type { IncomingAttachment } from './types'

/**
 * Attachments (images + documents) live next to the sessions, never inside the
 * JSONL: the transcript stays small and readable, and images are read back only
 * when a turn is actually sent to the model.
 */

export const ATTACHMENTS_DIR = 'attachments'
export const MAX_ATTACHMENTS = 8
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024
export const MAX_TEXT_BYTES = 200 * 1024
export const MAX_TEXT_IN_PROMPT = 60_000

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'env',
  'csv', 'tsv', 'log', 'xml', 'html', 'htm', 'css', 'scss', 'less',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'm', 'mm', 'scala', 'sh', 'bash',
  'zsh', 'fish', 'ps1', 'bat', 'sql', 'graphql', 'gql', 'proto', 'dockerfile', 'gitignore',
  'lock', 'patch', 'diff'
])

export function isImageMime(mime: string): boolean {
  return /^image\/(png|jpe?g|webp|gif|bmp|avif)$/i.test(mime)
}

export function detectKind(name: string, mime: string): 'image' | 'text' | undefined {
  if (isImageMime(mime)) return 'image'
  if (mime.startsWith('text/')) return 'text'
  if (/^(application\/(json|xml|x-yaml|yaml|x-sh|x-python|javascript|typescript))$/i.test(mime)) {
    return 'text'
  }
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  return undefined
}

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'allegato'
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_')
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'allegato'
}

function decodeDataUrl(dataUrl: string): { mime: string; base64: string } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) return { mime: 'application/octet-stream', base64: dataUrl }
  const mime = match[1] ?? 'application/octet-stream'
  const payload = match[3] ?? ''
  if (match[2]) return { mime, base64: payload }
  // Not base64: encode it so images still work if a caller sends raw text.
  return { mime, base64: Buffer.from(decodeURIComponent(payload), 'utf8').toString('base64') }
}

/** Keeps a user-provided id inside its directory: no separators, no `..`. */
function safeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '').replace(/^\.+/, '')
  return cleaned.length > 0 ? cleaned : fallback
}

export function attachmentsDir(platform: Platform, sessionId: string, messageId: string): string {
  return platform.configPath(
    ATTACHMENTS_DIR,
    safeSegment(sessionId, 'session'),
    safeSegment(messageId, 'message')
  )
}

export async function saveAttachments(
  platform: Platform,
  sessionId: string,
  messageId: string,
  incoming: IncomingAttachment[]
): Promise<AttachmentRef[]> {
  if (incoming.length === 0) return []
  if (incoming.length > MAX_ATTACHMENTS) {
    throw new Error(`Massimo ${MAX_ATTACHMENTS} allegati per messaggio.`)
  }

  const dir = attachmentsDir(platform, sessionId, messageId)
  await mkdir(dir, { recursive: true })

  const refs: AttachmentRef[] = []
  for (const item of incoming) {
    const kind = item.kind ?? detectKind(item.name, item.mime)
    if (!kind) {
      throw new Error(`Formato non supportato: ${item.name} (${item.mime || 'tipo sconosciuto'})`)
    }

    const size = item.size || item.data.length
    if (kind === 'image' && size > MAX_IMAGE_BYTES) {
      throw new Error(`Immagine troppo grande: ${item.name} (max 6 MB).`)
    }
    if (kind === 'text' && size > MAX_TEXT_BYTES) {
      throw new Error(`Documento troppo grande: ${item.name} (max 200 KB).`)
    }

    const id = randomUUID()
    const fileName = `${id}-${safeFileName(item.name)}`
    const path = `${dir}/${fileName}`
    const relative = `${ATTACHMENTS_DIR}/${safeSegment(sessionId, 'session')}/${safeSegment(
      messageId,
      'message'
    )}/${fileName}`

    if (kind === 'image') {
      const { base64 } = decodeDataUrl(item.data)
      await writeFile(path, Buffer.from(base64, 'base64'))
    } else {
      await writeFile(path, item.data, 'utf8')
    }

    refs.push({
      id,
      name: safeFileName(item.name),
      mime: item.mime || (kind === 'image' ? 'image/png' : 'text/plain'),
      size,
      kind,
      path: relative
    })
  }

  return refs
}

async function readRef(platform: Platform, ref: AttachmentRef): Promise<Buffer | undefined> {
  if (!ref.path) return undefined
  try {
    return await readFile(platform.configPath(ref.path))
  } catch {
    return undefined
  }
}

/**
 * Turns stored messages into model input: documents are inlined as fenced
 * blocks, images become base64 parts (only for vision models, but we let the
 * provider reject them rather than silently dropping user data).
 */
export async function materializeHistory(
  platform: Platform,
  messages: ChatMessage[]
): Promise<ChatMessage[]> {
  const result: ChatMessage[] = []

  for (const message of messages) {
    if (!message.attachments?.length) {
      result.push(message)
      continue
    }

    let content = message.content
    const images: { mediaType: string; data: string }[] = []

    for (const ref of message.attachments) {
      const buffer = await readRef(platform, ref)
      if (!buffer) continue

      if (ref.kind === 'image') {
        images.push({ mediaType: ref.mime, data: buffer.toString('base64') })
      } else {
        const text = buffer.toString('utf8').slice(0, MAX_TEXT_IN_PROMPT)
        const extension = ref.name.split('.').pop() ?? 'txt'
        content += `\n\n### Documento allegato: ${ref.name}\n\`\`\`${extension}\n${text}\n\`\`\``
      }
    }

    result.push({
      ...message,
      content,
      ...(images.length > 0 ? { images } : {})
    })
  }

  return result
}
