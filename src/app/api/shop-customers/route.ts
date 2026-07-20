import { NextResponse } from 'next/server'
import {
  getOwnedShopItems,
  getShopPurchases,
  type ShopProjectRef,
} from '@/lib/bendystraw'

export const dynamic = 'force-dynamic'

function parseProjects(raw: string | null): ShopProjectRef[] | null {
  if (!raw) return null
  const projects: ShopProjectRef[] = []
  const seen = new Set<string>()
  const projectByChain = new Map<number, number>()
  for (const part of raw.split(',')) {
    const [chainRaw, projectRaw, extra] = part.split(':')
    const chainId = Number(chainRaw)
    const projectId = Number(projectRaw)
    if (
      extra !== undefined ||
      !Number.isSafeInteger(chainId) ||
      chainId <= 0 ||
      !Number.isSafeInteger(projectId) ||
      projectId <= 0
    ) {
      return null
    }
    const existingProjectId = projectByChain.get(chainId)
    if (
      existingProjectId !== undefined &&
      existingProjectId !== projectId
    ) {
      return null
    }
    projectByChain.set(chainId, projectId)
    const key = `${chainId}:${projectId}`
    if (!seen.has(key)) {
      seen.add(key)
      projects.push({ chainId, projectId })
    }
  }
  return projects.length > 0 && projects.length <= 8 ? projects : null
}

/** Purchase history and current Shop holdings for the project detail tab. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const projects = parseProjects(searchParams.get('projects'))
  if (!projects) {
    return NextResponse.json(
      { error: 'Valid chainId:projectId pairs are required.' },
      { status: 400 },
    )
  }

  try {
    const owner = searchParams.get('owner')
    if (owner !== null) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) {
        return NextResponse.json(
          { error: 'A valid owner address is required.' },
          { status: 400 },
        )
      }
      return NextResponse.json(await getOwnedShopItems(projects, owner))
    }
    return NextResponse.json(await getShopPurchases(projects))
  } catch {
    return NextResponse.json(
      {
        items: [],
        totalCount: 0,
        capped: false,
        failedChains: projects.map(project => project.chainId),
      },
      { status: 502 },
    )
  }
}
