import { ImageResponse } from 'next/og'
import type { NextRequest } from 'next/server'
import { projectLogoUrl } from '@/lib/format'
import { getProjectLinkPreview } from '@/lib/project-link-preview'

export const runtime = 'nodejs'

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
  const logoUrl = resolvedLogo?.startsWith('/')
    ? new URL(resolvedLogo, request.nextUrl.origin).href
    : resolvedLogo
  const initial = project.name.charAt(0).toUpperCase() || 'J'

  return new ImageResponse(
    <div
      style={{
        background: '#fff7e8',
        color: '#1d1d1f',
        display: 'flex',
        height: '100%',
        padding: '64px 72px',
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
        <div
          style={{
            display: 'flex',
            fontSize: project.name.length > 28 ? 48 : 58,
            fontWeight: 700,
            lineHeight: 1.05,
          }}
        >
          {project.name}
        </div>
        {project.tagline ? (
          <div
            style={{
              color: '#595959',
              display: 'flex',
              fontSize: 27,
              lineHeight: 1.3,
              marginTop: 22,
            }}
          >
            {project.tagline}
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: 22, marginTop: 'auto' }}>
          <div
            style={{
              background: '#ffffff',
              border: '2px solid #e5ddcf',
              borderRadius: 18,
              display: 'flex',
              flex: 1,
              flexDirection: 'column',
              padding: '18px 22px',
            }}
          >
            <div style={{ color: '#77716a', display: 'flex', fontSize: 19 }}>Balance</div>
            <div style={{ display: 'flex', fontSize: 29, fontWeight: 700, marginTop: 7 }}>
              {project.balance}
            </div>
          </div>
          <div
            style={{
              background: '#ffffff',
              border: '2px solid #e5ddcf',
              borderRadius: 18,
              display: 'flex',
              flexDirection: 'column',
              minWidth: 190,
              padding: '18px 22px',
            }}
          >
            <div style={{ color: '#77716a', display: 'flex', fontSize: 19 }}>Payments</div>
            <div style={{ display: 'flex', fontSize: 29, fontWeight: 700, marginTop: 7 }}>
              {project.paymentsCount.toLocaleString('en-US')}
            </div>
          </div>
        </div>
        <div style={{ color: '#77716a', display: 'flex', fontSize: 18, marginTop: 18 }}>
          Juicebox · fund your thing
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
