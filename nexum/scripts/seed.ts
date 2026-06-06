import { createConnection } from 'node:net'

const BASE_URL = process.env.NEXUM_URL ?? 'http://localhost:3000'

async function post(path: string, body: unknown): Promise<unknown> {
  const url = new URL(path, BASE_URL)
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function main() {
  console.log('Seeding Nexum with demo data...')

  // Create corpus
  const corpus = await post('/corpora', { name: 'cuad-demo', description: 'CUAD contract demo corpus' }) as any
  console.log(`Created corpus: ${corpus.id}`)

  // Sample contract documents
  const contracts = [
    {
      title: 'Software License Agreement',
      content: `# Software License Agreement\n\nThis Software License Agreement ("Agreement") governs your use of the software.\n\n## License Grant\n\nSubject to the terms herein, we grant you a non-exclusive license to use the Software.\n\n## Restrictions\n\nYou may not copy, modify, or distribute the Software except as expressly permitted.\n\n## Indemnification\n\nYou agree to indemnify and hold harmless the Company from any claims arising from your use of the Software.`,
    },
    {
      title: 'Service Level Agreement',
      content: `# Service Level Agreement\n\nThis SLA defines the level of service you can expect from us.\n\n## Availability\n\nWe guarantee 99.9% uptime for the Service. See Exhibit A for exclusions.\n\n## Support\n\nSupport requests will be addressed within 24 hours.\n\n## Penalties\n\nFor each hour of downtime exceeding the SLA, you will receive credit per Section 3.2.`,
    },
    {
      title: 'Non-Disclosure Agreement',
      content: `# Non-Disclosure Agreement\n\nThis Agreement protects confidential information shared between the parties.\n\n## Definition\n\nConfidential Information means any information disclosed in connection with the Purpose.\n\n## Obligations\n\nEach party agrees to hold Confidential Information in strict confidence.\n\n## Exceptions\n\nThe obligations above do not apply to information that was publicly known prior to disclosure. However, information shared under this agreement remains protected.`,
    },
  ]

  for (const contract of contracts) {
    const doc = await post('/documents', {
      corpus_id: corpus.id,
      title: contract.title,
      content: contract.content,
      format: 'markdown',
    }) as any
    console.log(`Ingested "${contract.title}": ${doc.block_count} blocks (id: ${doc.id})`)
  }

  console.log(`\nDone! Corpus ID: ${corpus.id}`)
  console.log(`Try: curl -s -X POST ${BASE_URL}/query -H 'Content-Type: application/json' -d '{"corpus_id":"${corpus.id}","query":"indemnification","mode":"vector"}'`)
}

main().catch(err => { console.error(err); process.exit(1) })
