'use client'

import { writeHolds } from '@/lib/write-holds'

/** A parent review's line while held writes last only in this tab (private browsing): the SDK's. */
export function WriteRecoveryInTabNote() {
  const line = writeHolds.reviewLine()
  return line ? <p className="text-sm text-smoke-600">{line}</p> : null
}
