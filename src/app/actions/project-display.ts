'use server'

import { invalidateProjectDisplay } from '@/lib/project-server-data'

/** Public display refresh only; this action never changes project or wallet state. */
export async function refreshProjectDisplay(chainId: number, projectId: number): Promise<void> {
  if (!Number.isSafeInteger(chainId) || chainId <= 0 ||
      !Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error('Invalid project identity')
  }
  await invalidateProjectDisplay(chainId, projectId)
}
