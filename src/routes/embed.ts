import { route, send, readBody } from '../server.js'
import { embedTexts } from '../embed/local.js'

route('POST', '/blocks/embed', async (req, res) => {
  const body = await readBody(req) as any
  if (!body?.text || typeof body.text !== 'string' || !body.text.trim()) {
    return send(res, 400, { error: 'text is required' })
  }
  const [embedding] = await embedTexts([body.text])
  send(res, 200, { embedding })
})
