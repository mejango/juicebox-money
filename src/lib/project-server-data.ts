import { cache } from 'react'
import { getProjectPageData as readProjectPageData } from '@/lib/project-fallback'

/** One request-scoped identity read for the page, metadata and share preview. */
export const getProjectPageData = cache(readProjectPageData)
