import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET() {
  const pinning = process.env.IPFS_PINNING_ENABLED
  const ready =
    pinning === 'false' ||
    (pinning === 'true' &&
      process.env.IPFS_PINNING_EDGE_PROTECTED === 'true' &&
      (process.env.IPFS_PINNING_INGRESS_TOKEN?.trim().length ?? 0) >= 32 &&
      !!process.env.INFURA_IPFS_PROJECT_ID &&
      !!process.env.INFURA_IPFS_API_SECRET)

  return NextResponse.json(
    {
      status: ready ? 'ok' : 'misconfigured',
      version: process.env.NEXT_PUBLIC_VERSION || 'unknown',
    },
    {
      status: ready ? 200 : 503,
      headers: { 'cache-control': 'no-store' },
    },
  )
}
