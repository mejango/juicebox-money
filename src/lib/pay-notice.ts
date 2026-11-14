import { byChainOrder } from '@/lib/chainDisplay'

/** Each chain's payment notice as read: a string ('' for none), or null when its read failed. */
export type PayNotices = Readonly<Record<number, string | null>>

export type PayNoticeView = {
  /** The notice for the chain being paid; '' when it has none or it could not be read. */
  notice: string
  /** The paid chain's notice could not be read: say so and offer a retry, without blocking the payment. */
  failed: boolean
  /** The project's other chains whose notice reads differently, in display order. */
  others: { chainId: number; notice: string }[]
}

/**
 * What a payer is shown for the chain they pay on. Each chain keeps its own
 * project file, so the notice can differ between them: the payer sees the one
 * for their chain, and the others when they differ.
 */
export function payNoticeView(chainId: number, notices: PayNotices): PayNoticeView {
  const own = notices[chainId]
  return {
    notice: own ?? '',
    failed: own == null,
    others: Object.entries(notices)
      .map(([id, notice]) => ({ chainId: Number(id), notice }))
      .filter((row): row is { chainId: number; notice: string } =>
        row.chainId !== chainId && row.notice != null && own != null && row.notice !== own)
      .sort((a, b) => byChainOrder(a.chainId, b.chainId)),
  }
}
