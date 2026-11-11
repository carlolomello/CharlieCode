#!/usr/bin/env node
/**
 * Mock OpenAI-compatible router for Phase 0 verification and CI.
 *
 * It deliberately mimics the parts of FreeLLMAPI we depend on:
 *   GET  /v1/models            → list (includes a model that must be filtered out)
 *   POST /v1/chat/completions  → SSE streaming, non-streaming, tool calls, 429
 *
 * Usage:
 *   node scripts/mock-router.mjs [port]
 *   CHARLIE_BASE_URL=http://localhost:3999/v1 pnpm models
 */

import { createServer } from 'node:http'

const port = Number(process.env.MOCK_PORT ?? process.argv[2] ?? 3999)

const MODELS = [
  {
    id: 'mock/echo-fast',
    name: 'Mock Echo Fast',
    context_length: 32768,
    capabilities: { tools: true, vision: false }
  },
  {
    id: 'mock/echo-large',
    name: 'Mock Echo Large',
    context_length: 131072
  },
  {
    id: 'mock/vision-preview',
    name: 'Mock Vision Preview',
    context_length: 65536
  },
  {
    id: 'mock/flaky-429',
    name: 'Mock Flaky (always 429)',
    context_length: 8192
  },
  {
    id: 'mock/text-embedding-3-small',
    name: 'Embedding model (must be filtered out)',
    context_length: 8192
  }
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function usage(promptTokens, completionTokens) {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens
  }
}

function estimateTokens(text) {
  return Math.max(1, Math.round(String(text ?? '').length / 4))
}

function replyText(body) {
  const last = [...(body.messages ?? [])].reverse().find((message) => message.role === 'user')
  const prompt = typeof last?.content === 'string' ? last.content : 'ciao'
  return `[mock] ho ricevuto: "${prompt}". Streaming verificato riga per riga: ok.`
}

async function streamChat(res, body) {
  const model = body.model ?? 'mock/echo-fast'
  const text = replyText(body)
  const id = `chatcmpl-${Date.now()}`

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })

  for (const word of text.split(' ')) {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: `${word} ` }, finish_reason: null }]
    }
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    await sleep(25)
  }

  const final = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: usage(estimateTokens(JSON.stringify(body.messages ?? [])), estimateTokens(text))
  }
  res.write(`data: ${JSON.stringify(final)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function nonStreamingChat(res, body) {
  const model = body.model ?? 'mock/echo-fast'
  const wantsTools = Array.isArray(body.tools) && body.tools.length > 0
  const toolName = body.tools?.[0]?.function?.name ?? 'charlie_ping'

  if (wantsTools) {
    sendJson(res, 200, {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_mock_1',
                type: 'function',
                function: { name: toolName, arguments: JSON.stringify({ nonce: 'hello' }) }
              }
            ]
          }
        }
      ],
      usage: usage(20, 8)
    })
    return
  }

  const text = replyText(body)
  sendJson(res, 200, {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: usage(estimateTokens(JSON.stringify(body.messages ?? [])), estimateTokens(text))
  })
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)

  if (url.pathname.endsWith('/models') && req.method === 'GET') {
    sendJson(res, 200, { object: 'list', data: MODELS })
    return
  }

  if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
    void readBody(req)
      .then(async (body) => {
        const model = body.model ?? ''

        if (model.includes('flaky')) {
          sendJson(res, 429, {
            error: { message: 'mock: rate limit exceeded', type: 'rate_limit_error' }
          })
          return
        }

        if (body.stream === true) {
          await streamChat(res, body)
          return
        }

        nonStreamingChat(res, body)
      })
      .catch((error) => {
        sendJson(res, 400, { error: { message: String(error) } })
      })
    return
  }

  sendJson(res, 404, { error: { message: `mock: route non trovata ${req.method} ${url.pathname}` } })
})

server.listen(port, () => {
  console.log(`[mock-router] in ascolto su http://localhost:${port}/v1`)
})
