import { NextResponse } from 'next/server'
import { publicReadHeaders } from '@/lib/api-cache'
import { getRecentActivity } from '@/lib/bendystraw'

export const dynamic = 'force-dynamic'

/** Fresh-activity poll target for the client-side rail refresher. */
export async function GET() {
  try {
    const events = await getRecentActivity(12)
    return NextResponse.json({ events }, { headers: publicReadHeaders })
  } catch {
    return NextResponse.json({ events: [] }, { status: 502 })
  }
}
