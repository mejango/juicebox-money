import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      version: process.env.NEXT_PUBLIC_VERSION || 'unknown',
    },
    {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    },
  )
}
