import { createServer, IncomingMessage, ServerResponse } from 'node:http'

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>

interface Route {
  method: string
  pattern: string[]
  handler: Handler
}

const registeredRoutes: Route[] = []

export function route(method: string, path: string, handler: Handler) {
  registeredRoutes.push({ method, pattern: path.split('/'), handler })
}

function matchRoute(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
  const parts = pathname.split('/')
  for (const r of registeredRoutes) {
    if (r.method !== method || r.pattern.length !== parts.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < r.pattern.length; i++) {
      if (r.pattern[i].startsWith(':')) {
        params[r.pattern[i].slice(1)] = parts[i]
      } else if (r.pattern[i] !== parts[i]) {
        ok = false; break
      }
    }
    if (ok) return { handler: r.handler, params }
  }
  return null
}

export function createApp() {
  return createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    try {
      const pathname = req.url?.split('?')[0] ?? '/'
      const match = matchRoute(req.method!, pathname)
      if (!match) return send(res, 404, { error: 'not_found' })
      await match.handler(req, res, match.params)
    } catch (err: any) {
      send(res, err.status ?? 500, { error: err.message ?? 'internal_error' })
    }
  })
}

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString())
}

export function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) })
  res.end(json)
}
