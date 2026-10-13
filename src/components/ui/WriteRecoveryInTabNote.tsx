'use client'

import { WRITE_RECOVERY_IN_TAB_LINE, writeRecoveryIsDurable } from '@/lib/write-recovery'

/** A parent review's line where the browser can't keep held writes past this tab (private browsing). */
export function WriteRecoveryInTabNote() {
  if (writeRecoveryIsDurable()) return null
  return <p className="text-sm text-smoke-600">{WRITE_RECOVERY_IN_TAB_LINE}</p>
}
