import { NextRequest, NextResponse } from 'next/server'
import {
  pinToIpfs,
  readLimitedJson,
  requirePinningAccess,
  takeString,
} from '@/lib/ipfs-server'
import { isIpfsUri } from '@/lib/ipfs-cid'

export const runtime = 'nodejs'

/**
 * Pin a project-metadata JSON. Known fields are validated and length-capped
 * ({ name, projectTagline?, description?, logoUri?, infoUri?, twitter?,
 * discord?, … }); every OTHER key is pinned verbatim so owner edits
 * round-trip custom fields (a project's `leagueID`, nested extensions, …)
 * instead of destroying them. `readLimitedJson` caps the whole object, and
 * project pages sanitize on render, so the passthrough stays bounded.
 */
export async function POST(req: NextRequest) {
  const unavailable = requirePinningAccess(req)
  if (unavailable) return unavailable
  const parsed = await readLimitedJson(req, 16 * 1024)
  if ('response' in parsed) return parsed.response
  const body = parsed.value
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected a JSON object' }, { status: 400 })
  }

  const {
    name,
    projectTagline,
    description,
    logoUri,
    coverImageUri,
    payDisclosure,
    tags,
    infoUri,
    twitter,
    discord,
    telegram,
    whatsapp,
    instagram,
    ...unknownFields
  } = body as Record<string, unknown>

  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    return NextResponse.json(
      { error: 'name is required (1–100 characters)' },
      { status: 400 },
    )
  }

  const metadata: Record<string, string> = { name: name.trim() }

  const invalidTagline = takeString(metadata, 'projectTagline', projectTagline, 200)
  if (invalidTagline) return invalidTagline
  const invalidDescription = takeString(metadata, 'description', description, 5000)
  if (invalidDescription) return invalidDescription
  for (const [key, value] of [
    ['logoUri', logoUri],
    ['coverImageUri', coverImageUri],
  ] as const) {
    if (value === undefined) continue
    if (!isIpfsUri(value)) {
      return NextResponse.json({ error: `Invalid ${key}` }, { status: 400 })
    }
    metadata[key] = value
  }

  if (tags !== undefined) {
    if (
      !Array.isArray(tags) ||
      tags.length > 3 ||
      tags.some(t => typeof t !== 'string' || t.length > 30)
    ) {
      return NextResponse.json({ error: 'Invalid tags' }, { status: 400 })
    }
    if (tags.length > 0)
      (metadata as Record<string, unknown>).tags = tags
  }

  const invalidDisclosure = takeString(metadata, 'payDisclosure', payDisclosure, 1000)
  if (invalidDisclosure) return invalidDisclosure

  // Plain length-capped strings; project pages sanitize on render
  // (https-only URLs, handle-shaped twitter/instagram).
  const links: [string, unknown, number][] = [
    ['infoUri', infoUri, 300],
    ['twitter', twitter, 100],
    ['discord', discord, 300],
    ['telegram', telegram, 300],
    ['whatsapp', whatsapp, 300],
    ['instagram', instagram, 100],
  ]
  for (const [key, value, max] of links) {
    const invalid = takeString(metadata, key, value, max)
    if (invalid) return invalid
  }

  // Unknown keys round-trip verbatim; validated fields always win a name
  // collision (none is possible — they were destructured out above).
  const pinned: Record<string, unknown> = { ...unknownFields, ...metadata }

  try {
    const cid = await pinToIpfs(JSON.stringify(pinned), 'metadata.json')
    return NextResponse.json({ cid })
  } catch {
    return NextResponse.json({ error: 'Failed to pin metadata' }, { status: 502 })
  }
}
