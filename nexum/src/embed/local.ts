import { pipeline } from '@xenova/transformers'

type FeatureExtractionPipeline = Awaited<ReturnType<typeof pipeline>>

let _embedder: FeatureExtractionPipeline | null = null

async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!_embedder) {
    // @ts-ignore — pipeline typings are loose
    _embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
  }
  return _embedder
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const embedder = await getEmbedder()
  const output = await (embedder as any)(texts, { pooling: 'mean', normalize: true })
  const dim = 384
  const data: Float32Array = output.data
  return Array.from({ length: texts.length }, (_, i) =>
    Array.from(data.slice(i * dim, (i + 1) * dim))
  )
}
