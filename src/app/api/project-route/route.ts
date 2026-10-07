import { projectHandleFromRoute, decodeProjectRouteSegment } from '@/lib/project-handles'
import { projectRouteSnapshot, resolveProjectRoute } from '@/lib/project-route.server'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const segment = url.searchParams.get('segment') ?? ''
  const decoded = decodeProjectRouteSegment(segment)
  const headers = { 'Cache-Control': 'no-store' }
  if (!decoded || !projectHandleFromRoute(decoded)) {
    return Response.json({ error: 'Invalid project alias' }, { status: 400, headers })
  }
  try {
    const route = await resolveProjectRoute(segment, url.searchParams.get('fresh') === '1')
    if (route) return Response.json(projectRouteSnapshot(route), { headers })
  } catch {
    // An unavailable proof must not be reported as a missing project or cached.
  }
  return Response.json({ error: 'Project link could not be verified.' }, { status: 503, headers })
}
