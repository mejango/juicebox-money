import { NextResponse } from 'next/server'
import { publicReadHeaders } from '@/lib/api-cache'
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
  // chainId (when sent) is only an endpoint-routing hint — testnet sucker
  // groups live on the testnet indexer.
  const chainId = Number(searchParams.get('chainId'))

  try {
    return NextResponse.json(
      await getRevnetPriceHistory(suckerGroupId, {
        chainId: Number.isInteger(chainId) && chainId > 0 ? chainId : undefined,
      }),
      { headers: publicReadHeaders },
    )
  } catch {
    return NextResponse.json(
      { error: 'Price history is unavailable.' },
      { status: 502 },
    )
  }
}
