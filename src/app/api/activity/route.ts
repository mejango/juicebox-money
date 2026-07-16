import { NextResponse } from 'next/server'
import { getRecentActivity } from '@/lib/bendystraw'

export const dynamic = 'force-dynamic'

/** Fresh-activity poll target for the client-side rail refresher. */
export async function GET() {
  try {
    const events = await getRecentActivity(12)
    return NextResponse.json({ events })
  } catch {
    return NextResponse.json({ events: [] }, { status: 502 })
  }
}
