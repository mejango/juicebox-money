'use client'

import type { ComponentProps } from 'react'
import { ActivityList } from '@/components/ActivityList'
import { useIndexedAmountsTrusted } from '@/hooks/useIndexedAmountsTrusted'

/** TEMPORARY: see useIndexedAmountsTrusted. Kept out of ActivityList so other pages do not load the read. */
export function ProjectActivityList({
  deployments,
  ...props
}: Omit<ComponentProps<typeof ActivityList>, 'hideAmounts'> & {
  /** [chainId, projectId] for every deployment. */
  deployments: [number, number][]
}) {
  const trusted = useIndexedAmountsTrusted(deployments)
  return <ActivityList {...props} hideAmounts={trusted !== true} />
}
