'use client'

import { usePathname } from 'next/navigation'
import { ProjectPageSkeleton } from '@/components/LoadingSkeletons'
import { getProjectNavigationHint } from '@/lib/project-navigation'

export function ProjectPageLoading() {
  const pathname = usePathname()
  return <ProjectPageSkeleton hint={getProjectNavigationHint(pathname)} />
}
