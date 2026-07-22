import { NextRequest, NextResponse } from 'next/server'
import {
  pinToIpfs,
  readLimitedJson,
  requirePinningAccess,
  takeString,
} from '@/lib/ipfs-server'
import { isIpfsCidV0, isIpfsUri } from '@/lib/ipfs-cid'

export const runtime = 'nodejs'

/**
 * Pin a store-item (721 tier) metadata JSON: { name, description?, image? }.
 * Whitelisted and length-capped like pin-json. The returned CID is a CIDv0
 * (`Qm…`) — the 721 hook stores its sha2-256 digest onchain.
 */
export async function POST(req: NextRequest) {
  const unavailable = requirePinningAccess(req)
  if (unavailable) return unavailable
  const parsed = await readLimitedJson(req, 8 * 1024)
  if ('response' in parsed) return parsed.response
  const body = parsed.value
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

  const invalidDescription = takeString(metadata, 'description', description, 1000)
  if (invalidDescription) return invalidDescription
  // Images pin as `image`; other media as `animation_url` (website/ parity).
  for (const [key, value] of [
    ['image', image],
    ['animation_url', animation_url],
  ] as const) {
    if (value === undefined) continue
    if (!isIpfsUri(value)) {
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
    // `cidV0ToBytes32` is used by both create paths before the 721 hook call.
    // Refuse any other CID version here instead of letting a client discover
    // the incompatibility after the provider has accepted the upload.
    if (!isIpfsCidV0(cid)) throw new Error('Item metadata requires CIDv0')
    return NextResponse.json({ cid })
  } catch {
    return NextResponse.json({ error: 'Failed to pin item' }, { status: 502 })
  }
}
