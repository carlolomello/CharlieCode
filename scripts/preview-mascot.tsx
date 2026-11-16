/**
 * Dev-only: renders the mascot to a static HTML preview so it can be reviewed
 * in a browser without launching the whole app.
 *
 *   npx tsx --tsconfig tsconfig.web.json scripts/preview-mascot.tsx [out.html]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Mascot, MascotDesk, MascotTeam } from '../src/renderer/src/components/Mascot'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.argv[2] ?? join(root, 'mascot-preview.html')
const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')

const cells = [
  { label: '320px · walk', html: renderToStaticMarkup(<Mascot size={320} mood="idle" />) },
  { label: '320px · standing', html: renderToStaticMarkup(<Mascot size={320} mood="idle" still />) },
  { label: '320px · happy', html: renderToStaticMarkup(<Mascot size={320} mood="happy" still />) },
  { label: 'desk · working', html: renderToStaticMarkup(<MascotDesk width={320} mood="thinking" />) },
  { label: '64px (sidebar)', html: renderToStaticMarkup(<Mascot size={64} mood="idle" />) },
  { label: '140px (empty state)', html: renderToStaticMarkup(<Mascot size={140} mood="happy" />) },
  {
    label: 'team · 1 subagent',
    html: renderToStaticMarkup(
      <MascotTeam width={420} members={[{ id: 'a', label: 'esplora' }]} />
    )
  },
  {
    label: 'team · 2 subagent',
    html: renderToStaticMarkup(
      <MascotTeam
        width={420}
        members={[
          { id: 'a', label: 'esplora' },
          { id: 'b', label: 'implementa' }
        ]}
      />
    )
  },
  {
    label: 'team · 4 subagent',
    html: renderToStaticMarkup(
      <MascotTeam
        width={420}
        members={[
          { id: 'a', label: 'esplora' },
          { id: 'b', label: 'implementa' },
          { id: 'c', label: 'test' },
          { id: 'd', label: 'docs' }
        ]}
      />
    )
  },
  {
    label: 'team · 200px (badge)',
    html: renderToStaticMarkup(
      <MascotTeam
        width={200}
        members={[
          { id: 'a', label: 'esplora' },
          { id: 'b', label: 'implementa' }
        ]}
      />
    )
  }
]

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
${css}
body { margin: 0; background: #0e1116; color: #e7ecf3; font-family: ui-sans-serif, sans-serif; }
.stage { display: flex; flex-wrap: wrap; gap: 34px; padding: 36px; align-items: flex-end; }
.cell { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.label { font-size: 12px; color: #8b96a8; }
</style>
</head>
<body><div class="stage">
${cells.map((cell) => `<div class="cell">${cell.html}<span class="label">${cell.label}</span></div>`).join('\n')}
</div></body>
</html>`

writeFileSync(out, html, 'utf8')
console.log(`wrote ${out}`)
