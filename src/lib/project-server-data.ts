import { QueryClient, type QueryKey } from '@tanstack/react-query'
import { cache } from 'react'
import { ipfsUrl } from '@/lib/format'
import {
  getProject,
  getProjectActivity,
  getProjectActivityByProject,
  getSuckerGroupProjects,
  projectGroupIsIncomplete,
  type BsProject,
} from '@/lib/bendystraw'
import {
  getProjectPageData as readProjectPageData,
  readOnChainProject,
} from '@/lib/project-fallback'
import { ACTIVITY_PAGE_SIZE, PROJECT_ACTIVITY_FRESHNESS_MS } from '@/lib/project-activity'

const PROJECT_DISPLAY_FRESHNESS_MS = 30_000
// Next's revalidate cache may serve expired records after a failed refresh.
// fetchQuery instead waits for a new read after this public display TTL.
const displayQueries = new QueryClient({
  defaultOptions: {
    queries: { staleTime: PROJECT_DISPLAY_FRESHNESS_MS, gcTime: 5 * 60_000, retry: false },
  },
})

class IncompleteDisplayRead<T> extends Error {
  constructor(readonly result: { value: T; updatedAt: number }) {
    super('Project display read is incomplete')
  }
}

/** Incomplete results can render a fallback, but never populate a fresh cache. */
async function displayRead<T>(
  queryKey: QueryKey,
  read: () => Promise<T>,
  complete: (value: T) => boolean,
  staleTime = PROJECT_DISPLAY_FRESHNESS_MS,
): Promise<{ value: T; updatedAt: number }> {
  try {
    return await displayQueries.fetchQuery({
      queryKey,
      staleTime,
      queryFn: async () => {
        const value = await read()
        const result = { value, updatedAt: Date.now() }
        if (!complete(value)) throw new IncompleteDisplayRead(result)
        return result
      },
    })
  } catch (error) {
    if (error instanceof IncompleteDisplayRead) return error.result
    throw error
  }
}

export const getIndexedProjectDisplay = cache(async (chainId: number, projectId: number) =>
  (await displayRead(
    ['project-display', 'project', chainId, projectId],
    () => getProject(chainId, projectId, { policy: 'no-store' }),
    project => project !== null,
  )).value,
)

const getOnChainProjectDisplay = cache(async (chainId: number, projectId: number) =>
  (await displayRead(
    ['project-display', 'metadata-pointer', chainId, projectId],
    () => readOnChainProject(chainId, projectId),
    shell => !!shell?.metadataUriResolved,
  )).value,
)

/** One request-scoped identity read for the page, metadata and share preview. */
export const getProjectPageData = cache((chainId: number, projectId: number) =>
  readProjectPageData(chainId, projectId, {
    getProject: getIndexedProjectDisplay,
    readOnChainProject: getOnChainProjectDisplay,
  }),
)

export const getProjectSiblings = cache(async (
  chainId: number,
  projectId: number,
  suckerGroupId: string,
) => (await displayRead(
  ['project-display', 'siblings', chainId, projectId, suckerGroupId],
  () => getSuckerGroupProjects(suckerGroupId, chainId, { policy: 'no-store' }),
  projects => !projectGroupIsIncomplete({ chainId, projectId, version: 6, suckerGroupId }, projects),
)).value)

/** The timestamp belongs to the successful upstream read, even on cache hits. */
export const getProjectActivityDisplay = cache((
  chainId: number,
  projectId: number,
  suckerGroupId: string | null,
) => displayRead(
  ['project-display', 'activity', chainId, projectId, suckerGroupId],
  () => suckerGroupId
    ? getProjectActivity(suckerGroupId, ACTIVITY_PAGE_SIZE, chainId, 0, { policy: 'no-store' })
    : getProjectActivityByProject(chainId, projectId, ACTIVITY_PAGE_SIZE, 0, { policy: 'no-store' }),
  () => true,
  PROJECT_ACTIVITY_FRESHNESS_MS,
))

/** Also evict sibling snapshots that contain a locally changed deployment. */
export async function invalidateProjectDisplay(chainId: number, projectId: number): Promise<void> {
  const filters = {
    predicate: (query: import('@tanstack/react-query').Query) => query.queryKey[0] === 'project-display' && (
      (query.queryKey[2] === chainId && query.queryKey[3] === projectId) ||
      (query.queryKey[1] === 'siblings' &&
        // An in-flight group's membership is unknown: it may contain this
        // deployment, so it cannot finish by installing a pre-edit snapshot.
        (!query.state.data || (query.state.data as { value: BsProject[] }).value.some(
          project => project.chainId === chainId && project.projectId === projectId,
        )))
    ),
  }
  await displayQueries.cancelQueries(filters)
  displayQueries.removeQueries(filters)
}

export type ProjectMetadata = {
  name?: string;
  projectTagline?: string;
  description?: string;
  logoUri?: string;
  coverImageUri?: string;
  payDisclosure?: string;
  infoUri?: string;
  twitter?: string;
  discord?: string;
  telegram?: string;
  whatsapp?: string;
  instagram?: string;
};

export const getProjectMetadata = cache(async function fetchProjectMetadata(
  metadataUri: string | null,
): Promise<ProjectMetadata | null> {
  const url = ipfsUrl(metadataUri);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as unknown;
    return typeof json === "object" && json !== null && !Array.isArray(json)
      ? (json as ProjectMetadata)
      : null;
  } catch {
    return null;
  }
})
