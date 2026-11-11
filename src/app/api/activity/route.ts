import { NextResponse } from 'next/server'
import { readActivityRows } from '@/lib/activity-rows'
import { publicReadHeaders } from '@/lib/api-cache'
import { getRecentActivity } from '@/lib/bendystraw'
import { readIndexedMetadataJson } from '@/lib/metadata-json.server'

export const dynamic = 'force-dynamic'

const DEFAULT_ROWS = 8
const MAX_ROWS = 32

function pageParam(value: string | null, fallback: number, max?: number) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback
  return max === undefined ? parsed : Math.min(parsed, max)
}

/** Fresh activity by feed row from an event offset, and the poll target for the client-side rail. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const rows = pageParam(searchParams.get('rows'), DEFAULT_ROWS, MAX_ROWS)
  const offset = pageParam(searchParams.get('offset'), 0)
  try {
    const page = await readActivityRows(
      (limit, from) => getRecentActivity(limit, from, readIndexedMetadataJson),
      rows,
      offset,
    )
    return NextResponse.json(page, { headers: publicReadHeaders })
  } catch {
    return NextResponse.json(
      { events: [], hasMore: false },
      { status: 502 },
    )
  }
}
