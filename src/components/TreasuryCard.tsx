'use client'

import { type JBChainId } from '@bananapus/nana-sdk-core'
import { useState } from 'react'
import { CashOutPanel } from '@/components/project/CashOutFlow'
import { PayPanel } from '@/components/project/PayPanel'

type Tab = 'pay' | 'cashOut'

/**
 * The project page's treasury card: a two-tab island for putting funds in
 * ("Pay") and taking your share back out ("Cash out").
 */
export function TreasuryCard({
  chainId,
  projectId,
  projectName,
  isRevnet,
  accountingToken,
  accountingTokenSymbol,
  payDisclosure,
}: {
  chainId: JBChainId
  projectId: number
  projectName: string
  isRevnet: boolean
  /** The accounting token's address per bendystraw. */
  accountingToken?: string | null
  /** The accounting token's symbol per bendystraw (e.g. "ETH", "USDC"). */
  accountingTokenSymbol?: string | null
  /** The project's payment notice, shown before paying. */
  payDisclosure?: string
}) {
  const [tab, setTab] = useState<Tab>('pay')

  const tabClass = (active: boolean) =>
    `min-h-[40px] rounded-lg font-agrandir text-sm font-medium transition-colors ${
      active
        ? 'bg-bluebs-25 text-bluebs-700'
        : 'text-smoke-700 hover:text-ink'
    }`

  return (
    <div className="card p-6">
      <div
        role="tablist"
        aria-label="Treasury actions"
        className="grid grid-cols-2 gap-1 rounded-xl border border-smoke-200 bg-smoke-75 p-1"
      >
        <button
          role="tab"
          aria-selected={tab === 'pay'}
          onClick={() => setTab('pay')}
          className={tabClass(tab === 'pay')}
        >
          Pay
        </button>
        <button
          role="tab"
          aria-selected={tab === 'cashOut'}
          onClick={() => setTab('cashOut')}
          className={tabClass(tab === 'cashOut')}
        >
          Cash out
        </button>
      </div>

      <div className="mt-5">
        {tab === 'pay' ? (
          <PayPanel
            chainId={chainId}
            projectId={projectId}
            projectName={projectName}
            isRevnet={isRevnet}
            payDisclosure={payDisclosure}
          />
        ) : (
          <CashOutPanel
            chainId={chainId}
            projectId={projectId}
            projectName={projectName}
            accountingToken={accountingToken}
            accountingTokenSymbol={accountingTokenSymbol}
            onGoToPay={() => setTab('pay')}
          />
        )}
      </div>
    </div>
  )
}
