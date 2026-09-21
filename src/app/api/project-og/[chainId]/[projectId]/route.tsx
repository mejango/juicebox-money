import { ImageResponse } from 'next/og'
import type { NextRequest } from 'next/server'
import sharp from 'sharp'
import { projectLogoUrl } from '@/lib/format'
import { getProjectLinkPreview } from '@/lib/project-link-preview'

export const runtime = 'nodejs'

const LOGO_MAX_BYTES = 8 * 1024 * 1024
const LOGO_FETCH_TIMEOUT_MS = 6_000

/**
 * The logo as a 360px PNG data URI, or null. Satori only draws PNG, JPEG, GIF
 * and SVG, so a webp/avif logo (what most project logos are) rendered as a
 * blank square; a fetch it cannot complete rendered the same. Converting here
 * covers every format sharp reads and keeps the card independent of the
 * renderer's own network reach.
 */
async function logoDataUri(source: string | null): Promise<string | null> {
  if (!source) return null
  try {
    let bytes: Buffer
    if (source.startsWith('data:')) {
      const comma = source.indexOf(',')
      const header = source.slice(0, comma)
      const payload = source.slice(comma + 1)
      bytes = header.endsWith(';base64')
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'utf8')
    } else {
      const response = await fetch(source, {
        signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS),
        next: { revalidate: 60 * 60 * 24 },
      })
      if (!response.ok) return null
      const length = Number(response.headers.get('content-length') ?? 0)
      if (length > LOGO_MAX_BYTES) return null
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > LOGO_MAX_BYTES) return null
      bytes = Buffer.from(buffer)
    }
    const png = await sharp(bytes, { animated: false })
      .resize(360, 360, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
    return `data:image/png;base64,${png.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * One size for both stat values so the pair fits the 648px column on one
 * line: bold digits run about 0.66em wide, and the gap between them is 72px.
 */
function statFontSize(balance: string, payments: string): number {
  const fitted = Math.floor((648 - 72) / (0.66 * (balance.length + payments.length)))
  return Math.max(40, Math.min(96, fitted))
}

/** A headline size the 648px column fits in two lines at 700 weight. */
function nameFontSize(name: string): number {
  if (name.length > 44) return 44
  if (name.length > 30) return 52
  if (name.length > 18) return 64
  return 84
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ chainId: string; projectId: string }> },
) {
  const raw = await params
  const chainId = Number(raw.chainId)
  const projectId = Number(raw.projectId)
  if (
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !Number.isSafeInteger(projectId) ||
    projectId <= 0
  ) {
    return new Response(null, { status: 400 })
  }

  const project = await getProjectLinkPreview(chainId, projectId)
  if (!project) return new Response(null, { status: 404 })

  const resolvedLogo = projectLogoUrl(project.logoUri)
  // Not `request.nextUrl.origin`: behind the platform proxy that is the container's bind
  // address (https://0.0.0.0:8080/...), which this renderer cannot fetch, and the card
  // silently loses its logo.
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? request.nextUrl.origin
  const logoUrl = await logoDataUri(
    resolvedLogo?.startsWith('/') ? new URL(resolvedLogo, origin).href : resolvedLogo,
  )
  const initial = project.name.charAt(0).toUpperCase() || 'J'
  const payments = project.paymentsCount.toLocaleString('en-US')
  const statSize = statFontSize(project.balance, payments)

  return new ImageResponse(
    <div
      style={{
        background: '#fff7e8',
        color: '#1d1d1f',
        display: 'flex',
        height: '100%',
        padding: '56px 64px',
        width: '100%',
      }}
    >
      <div
        style={{
          alignItems: 'center',
          display: 'flex',
          height: 360,
          justifyContent: 'center',
          overflow: 'hidden',
          width: 360,
        }}
      >
        {logoUrl ? (
          // Satori rejects string width/height ("Invalid value 360…") and then
          // renders nothing, which left a hole where every project logo belongs.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt=""
            width={360}
            height={360}
            style={{ objectFit: 'contain' }}
          />
        ) : (
          <div
            style={{
              alignItems: 'center',
              background: '#ffcc00',
              borderRadius: 48,
              display: 'flex',
              fontSize: 172,
              fontWeight: 700,
              height: 340,
              justifyContent: 'center',
              width: 340,
            }}
          >
            {initial}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          flex: 1,
          flexDirection: 'column',
          marginLeft: 64,
          minWidth: 0,
        }}
      >
        {/* Satori does not clip overflow: an unclamped name or tagline runs
            straight through the stats below, so both are held to two lines and
            the stats refuse to shrink. */}
        <div
          style={{
            display: 'block',
            fontSize: nameFontSize(project.name),
            fontWeight: 700,
            lineClamp: 2,
            lineHeight: 1.05,
          }}
        >
          {project.name}
        </div>
        {project.tagline ? (
          <div
            style={{
              color: '#3a3a3c',
              display: 'block',
              fontSize: 36,
              lineClamp: 2,
              lineHeight: 1.3,
              marginTop: 20,
            }}
          >
            {project.tagline}
          </div>
        ) : null}

        <div style={{ display: 'flex', flexShrink: 0, gap: 72, marginTop: 'auto', paddingTop: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ color: '#5c5751', display: 'flex', fontSize: 36 }}>Balance</div>
            <div
              style={{
                display: 'flex',
                fontSize: statSize,
                fontWeight: 700,
                lineHeight: 1,
                marginTop: 8,
              }}
            >
              {project.balance}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ color: '#5c5751', display: 'flex', fontSize: 36 }}>Payments</div>
            <div style={{ display: 'flex', fontSize: statSize, fontWeight: 700, lineHeight: 1, marginTop: 8 }}>
              {payments}
            </div>
          </div>
        </div>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      headers: {
        'cache-control': 'public, max-age=300, s-maxage=300',
      },
    },
  )
}
