import { NextRequest, NextResponse } from 'next/server'
import { pinToIpfs } from '@/lib/ipfs-server'

export const runtime = 'nodejs'

/**
 * Pin a store-item (721 tier) metadata JSON: { name, description?, image? }.
 * Whitelisted and length-capped like pin-json. The returned CID is a CIDv0
 * (`Qm…`) — the 721 hook stores its sha2-256 digest onchain.
 */
export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected a JSON object' }, { status: 400 })
  }

  const { name, description, image, animation_url, mediaType, categoryName } =
    body as Record<string, unknown>

  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    return NextResponse.json(
      { error: 'name is required (1–100 characters)' },
      { status: 400 },
    )
  }

  const metadata: Record<string, string> = { name: name.trim() }

  if (description !== undefined) {
    if (typeof description !== 'string' || description.length > 1000) {
      return NextResponse.json({ error: 'Invalid description' }, { status: 400 })
    }
    if (description.trim()) metadata.description = description.trim()
  }
  // Images pin as `image`; other media as `animation_url` (website/ parity).
  for (const [key, value] of [
    ['image', image],
    ['animation_url', animation_url],
  ] as const) {
    if (value === undefined) continue
    if (
      typeof value !== 'string' ||
      !/^ipfs:\/\/[a-zA-Z0-9]{1,128}$/.test(value)
    ) {
      return NextResponse.json({ error: `Invalid ${key}` }, { status: 400 })
    }
    metadata[key] = value
  }
  if (mediaType !== undefined) {
    if (
      typeof mediaType !== 'string' ||
      !/^[a-z]+\/[\w.+-]{1,80}$/.test(mediaType)
    ) {
      return NextResponse.json({ error: 'Invalid mediaType' }, { status: 400 })
    }
    metadata.mediaType = mediaType
  }
  if (categoryName !== undefined) {
    if (
      typeof categoryName !== 'string' ||
      !categoryName.trim() ||
      categoryName.trim().length > 40
    ) {
      return NextResponse.json(
        { error: 'Invalid categoryName' },
        { status: 400 },
      )
    }
    metadata.categoryName = categoryName.trim()
  }

  try {
    const cid = await pinToIpfs(JSON.stringify(metadata), 'item.json')
    return NextResponse.json({ cid })
  } catch {
    return NextResponse.json({ error: 'Failed to pin item' }, { status: 502 })
  }
}
