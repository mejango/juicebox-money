import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET() {
  const pinning = process.env.IPFS_PINNING_ENABLED
  const edgeProtected = process.env.IPFS_PINNING_EDGE_PROTECTED
  const ingressReady =
    edgeProtected === 'true'
      ? (process.env.IPFS_PINNING_INGRESS_TOKEN?.trim().length ?? 0) >= 32
      : edgeProtected === 'false' && !process.env.IPFS_PINNING_INGRESS_TOKEN
  const ready =
    pinning === 'false' ||
    (pinning === 'true' &&
      ingressReady &&
      !!process.env.FILEBASE_IPFS_RPC_TOKEN &&
      !!process.env.PINATA_JWT)

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
