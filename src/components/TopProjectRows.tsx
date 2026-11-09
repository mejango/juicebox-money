'use client'

import { useCallback, useState } from 'react'
import type { TopBalanceProject } from '@/lib/top-projects'
import { LoadMoreRow } from './LoadMoreRow'
import { ProjectLogo } from './ProjectLogo'
import { ProjectRowName, repeatedNames } from './ProjectRowName'
import { ProjectLink } from './ProjectLink'

const PAGE_SIZE = 8

export function TopProjectRows({
  initialProjects,
  initialHasMore,
}: {
  initialProjects: TopBalanceProject[]
  initialHasMore: boolean
}) {
  const [projects, setProjects] = useState(initialProjects)
  const [hasMore, setHasMore] = useState(initialHasMore)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return
    setLoading(true)
    setLoadError(null)
    try {
      const response = await fetch(
        `/api/top-projects?limit=${PAGE_SIZE}&offset=${projects.length}`,
      )
      if (!response.ok) throw new Error('Top projects unavailable')
      const page = (await response.json()) as {
        projects?: TopBalanceProject[]
        hasMore?: boolean
      }
      const next = page.projects ?? []
      setProjects(current => [
        ...current,
        ...next.filter(
          project => !current.some(existing => existing.key === project.key),
        ),
      ])
      setHasMore(Boolean(page.hasMore))
    } catch {
      setLoadError('Could not load more projects. Try again.')
    } finally {
      setLoading(false)
    }
  }, [hasMore, loading, projects.length])
  const repeated = repeatedNames(projects)

  if (!projects.length) {
    return (
      <p className="flex min-h-[420px] items-center justify-center px-6 text-center text-sm text-smoke-600">
        Projects are temporarily unavailable.
      </p>
    )
  }

  return (
    <ol className="divide-y divide-smoke-100">
      {projects.map((project, index) => (
        <li key={project.key}>
          <ProjectLink
            href={project.href}
            projectHint={{
              name: project.name,
              logoUri: project.logoUri,
              tagline: project.tagline,
            }}
            className="group flex h-28 items-center gap-3 px-4 py-3"
          >
            <span className="w-5 shrink-0 text-xs tabular-nums text-smoke-500">
              {index + 1}
            </span>
            <ProjectLogo
              name={project.name}
              logoUri={project.logoUri}
              size={40}
              eager={index < 4}
            />
            <span className="min-w-0 flex-1">
              <ProjectRowName
                name={project.name}
                projectId={project.projectId}
                repeated={repeated.has(project.name)}
              />
              <span className="mt-0.5 block text-xs text-smoke-600">
                Balance:{' '}
                <span className="tabular-nums text-smoke-700">
                  {project.balanceUsd.toLocaleString('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    maximumFractionDigits: 0,
                  })}
                </span>
              </span>
            </span>
          </ProjectLink>
        </li>
      ))}
      {(hasMore || loading) && (
        <LoadMoreRow label="More projects" loading={loading} error={loadError} onLoadMore={loadMore} />
      )}
    </ol>
  )
}
