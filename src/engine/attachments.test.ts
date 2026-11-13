import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENTS,
  MAX_TEXT_IN_PROMPT,
  attachmentsDir,
  detectKind,
  materializeHistory,
  saveAttachments
} from './attachments'
import { createPlatform, type Platform } from './platform'

let home: string
let platform: Platform

// 1x1 transparent PNG.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'charliecode-attachments-'))
  platform = createPlatform({ id: 'darwin', env: { HOME: home } })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('detectKind', () => {
  it('riconosce immagini, testo e formati sconosciuti', () => {
    expect(detectKind('a.png', 'image/png')).toBe('image')
    expect(detectKind('note.txt', 'text/plain')).toBe('text')
    expect(detectKind('main.ts', 'application/octet-stream')).toBe('text')
    expect(detectKind('data.bin', 'application/octet-stream')).toBeUndefined()
  })
})

describe('saveAttachments', () => {
  it('scrive immagini e documenti su disco e torna i metadati', async () => {
    const refs = await saveAttachments(platform, 'session-1', 'message-1', [
      { name: 'pixel.png', mime: 'image/png', kind: 'image', size: 68, data: PNG_DATA_URL },
      { name: 'note.md', mime: 'text/markdown', kind: 'text', size: 5, data: '# ciao' }
    ])

    expect(refs).toHaveLength(2)
    expect(refs[0]?.kind).toBe('image')
    expect(refs[0]?.path).toMatch(/^attachments\/session-1\/message-1\/.+pixel\.png$/)
    expect(refs[1]?.path).toMatch(/^attachments\/session-1\/message-1\/.+note\.md$/)

    const image = await readFile(platform.configPath(refs[0]!.path!), 'base64')
    expect(Buffer.from(image, 'base64').subarray(1, 4).toString()).toBe('PNG')

    const text = await readFile(platform.configPath(refs[1]!.path!), 'utf8')
    expect(text).toBe('# ciao')
  })

  it('ripulisce i nomi e non esce dalla cartella della sessione', async () => {
    const [ref] = await saveAttachments(platform, '../evil', '../../msg', [
      { name: '../../etc/passwd', mime: 'text/plain', kind: 'text', size: 3, data: 'abc' }
    ])
    expect(ref?.path).toMatch(/^attachments\/evil\/msg\//)
    expect(ref?.name).not.toContain('/')
  })

  it('rifiuta immagini troppo grandi e troppi allegati', async () => {
    await expect(
      saveAttachments(platform, 's', 'm', [
        {
          name: 'huge.png',
          mime: 'image/png',
          kind: 'image',
          size: 7 * 1024 * 1024,
          data: PNG_DATA_URL
        }
      ])
    ).rejects.toThrow(/troppo grande/)

    const tooMany = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => ({
      name: `n${index}.txt`,
      mime: 'text/plain',
      kind: 'text' as const,
      size: 1,
      data: 'x'
    }))
    await expect(saveAttachments(platform, 's', 'm', tooMany)).rejects.toThrow(/Massimo/)
  })

  it('non fa nulla senza allegati', async () => {
    expect(await saveAttachments(platform, 's', 'm', [])).toEqual([])
  })
})

describe('materializeHistory', () => {
  it('inlinea i documenti e allega le immagini in base64', async () => {
    const refs = await saveAttachments(platform, 's1', 'm1', [
      { name: 'pixel.png', mime: 'image/png', kind: 'image', size: 68, data: PNG_DATA_URL },
      { name: 'note.md', mime: 'text/markdown', kind: 'text', size: 5, data: '# ciao' }
    ])

    const [message] = await materializeHistory(platform, [
      { role: 'user', content: 'guarda', attachments: refs }
    ])

    expect(message?.content).toContain('### Documento allegato: note.md')
    expect(message?.content).toContain('# ciao')
    expect(message?.images?.[0]?.mediaType).toBe('image/png')
    expect(message?.images?.[0]?.data.length).toBeGreaterThan(10)
  })

  it('tronca i documenti lunghi e ignora i file spariti', async () => {
    const dir = attachmentsDir(platform, 's2', 'm2')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'big.txt'), 'y'.repeat(MAX_TEXT_IN_PROMPT + 500), 'utf8')

    const [message] = await materializeHistory(platform, [
      {
        role: 'user',
        content: '',
        attachments: [
          {
            id: 'a',
            name: 'big.txt',
            mime: 'text/plain',
            size: 1,
            kind: 'text',
            path: 'attachments/s2/m2/big.txt'
          },
          {
            id: 'b',
            name: 'gone.txt',
            mime: 'text/plain',
            size: 1,
            kind: 'text',
            path: 'attachments/s2/m2/gone.txt'
          }
        ]
      }
    ])

    expect(message?.content).toContain('y'.repeat(MAX_TEXT_IN_PROMPT))
    expect(message?.content).not.toContain('y'.repeat(MAX_TEXT_IN_PROMPT + 1))
    expect(message?.content).not.toContain('gone.txt')
  })
})
