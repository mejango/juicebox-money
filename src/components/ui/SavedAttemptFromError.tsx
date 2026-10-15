'use client'

import dynamic from 'next/dynamic'
import type { SavedAttempt } from '@bananapus/nana-sdk-core/review'

const SavedAttemptRecovery = dynamic(() => import('@/components/ui/SavedAttemptRecovery'), { ssr: false })

/**
 * A flow stopped on a saved attempt the SDK's recovery is showing
 * (SavedAttemptShownError): its held line and exit, or its one check. Once it
 * retires or settles, `onDone` lets the flow run again. Anything else shows
 * nothing here. By name, so the hold's module loads only with the flow.
 */
export function SavedAttemptFromError({ error, checkNext = 'Review it again', onDone }: {
  error: unknown
  checkNext?: string
  onDone: () => void
}) {
  if (!(error instanceof Error) || error.name !== 'SavedAttemptShownError' || !('attempt' in error)) return null
  const { attempt } = error as Error & { attempt: SavedAttempt<unknown> }
  return <SavedAttemptRecovery attempt={attempt} checkNext={checkNext} onRetired={onDone} onFollow={onDone} />
}
