import { NextResponse } from 'next/server'
import { getRevnetPriceHistory } from '@/lib/bendystraw'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const suckerGroupId = searchParams.get('suckerGroupId')
  if (!suckerGroupId || !/^[a-zA-Z0-9_-]{1,128}$/.test(suckerGroupId)) {
    return NextResponse.json(
      { error: 'A valid suckerGroupId is required.' },
      { status: 400 },
    )
  }

  try {
    return NextResponse.json(await getRevnetPriceHistory(suckerGroupId))
  } catch {
    return NextResponse.json(
      { error: 'Price history is unavailable.' },
      { status: 502 },
    )
  }
}
