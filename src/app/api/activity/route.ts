import { NextResponse } from 'next/server'
import { publicReadHeaders } from '@/lib/api-cache'
import { getRecentActivity } from '@/lib/bendystraw'
import { readIndexedMetadataJson } from '@/lib/metadata-json.server'

export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 8
const MAX_LIMIT = 32

function pageParam(value: string | null, fallback: number, max?: number) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback
  return max === undefined ? parsed : Math.min(parsed, max)
}

/** Paginated fresh activity and the poll target for the client-side rail. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const limit = pageParam(searchParams.get('limit'), DEFAULT_LIMIT, MAX_LIMIT)
  const offset = pageParam(searchParams.get('offset'), 0)
  try {
    const page = await getRecentActivity(limit + 1, offset, readIndexedMetadataJson)
    return NextResponse.json(
      { events: page.slice(0, limit), hasMore: page.length > limit },
      { headers: publicReadHeaders },
    )
  } catch {
    return NextResponse.json(
      { events: [], hasMore: false },
      { status: 502 },
    )
  }
}
