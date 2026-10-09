'use client'

import { isAddressEqual, type Address, type Hex } from 'viem'
import { requireFundingChainSelection } from '@/lib/transaction-review'
import { RelayrPaymentSubmittedError, relayrChainClient, relayrPay, relayrPaymentLabel, relayrPoll, relayrPostBundle } from '@/lib/relayr'
import { proveSavedRelayrPayment, relayrDeadlinePassed, relayrQuotedOptions, relayrPaymentAttemptOutcome, relayrPaymentOptions, relayrRetryOption, requireRelayrBundleUnpaid, revertedRelayrQuote, type RelayrEntry, type RelayrPayment, type RelayrQuote, type RelayrSentPayment, type RelayrTransactionRecord } from '@bananapus/nana-sdk-core/review/relayr'

export type RawRelayrState = {
  account: Address
  phase: 'reviewed' | 'publishing' | 'quoted' | 'payment-sending' | 'payment-reverted' | 'executing' | 'complete'
  quote?: RelayrQuote
  payments?: RelayrSentPayment[]
  paymentHash?: Hex
  paymentChainId?: number
  records: RelayrTransactionRecord[]
}

export function assertRawQuoteBindings(quote: RelayrQuote, entries: RelayrEntry[], changedCallMessage = 'The original quote changed a reviewed call.'): void {
  const bindings = quote.expectedTransactions
  if (!bindings || bindings.length !== entries.length || new Set(bindings.map(item => item.txUuid.toLowerCase())).size !== bindings.length) {
    throw new Error('The original quote has no complete transaction bindings. Keep it pending.')
  }
  bindings.forEach((binding, index) => {
    const expected = entries[index]
    if (binding.chain !== expected.chain || binding.entry.chain !== expected.chain ||
        !isAddressEqual(binding.entry.target, expected.target) || binding.entry.data.toLowerCase() !== expected.data.toLowerCase() ||
        BigInt(binding.entry.value) !== 0n || (binding.entry.virtual_nonce ?? 0) !== (expected.virtual_nonce ?? 0)) {
      throw new Error(changedCallMessage)
    }
  })
}

/** A read-only proof that an unfunded raw quote can no longer accept payment. */
export async function isExpiredUnfundedRawQuote(session: RawRelayrState, chains: number[]): Promise<boolean> {
  if (!session.quote || session.phase !== 'quoted' || session.payments?.length || session.paymentHash ||
      session.paymentChainId !== undefined || relayrPaymentOptions(session.quote, chains).length) return false
  const options = relayrQuotedOptions(session.quote, chains)
  if (!options.length) return false
  for (const { option, details } of options) {
    const client = relayrChainClient(option.chain)
    if (!client || !await relayrDeadlinePassed(client, details.deadline)) return false
  }
  await requireRelayrBundleUnpaid(session.quote.bundle_uuid)
  return true
}

/** Shared raw-call funding lifecycle. Owners durably save every transition before external writes. */
export async function runRawRelayrLifecycle<S extends RawRelayrState>({ session, entries, saveState: save, assertAccount, reverify, preferredPaymentChainId, changedCallMessage, lostQuoteMessage }: {
  session: S
  entries: RelayrEntry[]
  saveState: (session: S, beforeWrite?: boolean) => void
  assertAccount: () => void
  reverify: () => Promise<void>
  changedCallMessage?: string
  lostQuoteMessage?: string
  preferredPaymentChainId?: number
}): Promise<unknown> {
  const persist = (beforeWrite = false) => save(session, beforeWrite)
      const requestQuote = async () => {
        await reverify()
        assertAccount()
        session.phase = 'publishing'
        delete session.quote
        persist(true)
        session.quote = await relayrPostBundle(entries)
        assertRawQuoteBindings(session.quote!, entries, changedCallMessage)
        session.phase = 'quoted'
        persist()
      }
      if (session.phase === 'reviewed') await requestQuote()
      const chains = [...new Set(entries.map(entry => entry.chain))]
      // Another payment may have funded a quote whose own payment reverted:
      // what Relayr ran is proven below, never paid again.
      let fundedElsewhere = false
      if (session.phase === 'payment-reverted' && session.quote) {
        const reverted = await revertedRelayrQuote(relayrChainClient, { bundleUuid: session.quote.bundle_uuid, payments: session.payments ?? [],
          options: session.quote.payment_info, destinationChainIds: chains, account: session.account })
        if (reverted.records) {
          session.records = reverted.records
          persist()
        }
        fundedElsewhere = reverted.state === 'funded'
        if (reverted.state === 'released') {
          // Ruling R104: nothing can fund the quote any more, so the same raw
          // calls are quoted again, with a new funding choice.
          delete session.payments
          delete session.paymentHash
          delete session.paymentChainId
          await requestQuote()
        }
      }
      if (await isExpiredUnfundedRawQuote(session, chains)) {
        // Every authenticated payment deadline is past at a canonical finalized
        // block, and Relayr confirms the quote unpaid with every call pending.
        // Only that proof permits quoting these raw calls again.
        await requestQuote()
      }
      const quote = session.quote
      if (!quote) throw new Error(lostQuoteMessage ?? 'The original quote response is unavailable. Keep this attempt pending; requesting another bundle could execute duplicate calls.')
      assertRawQuoteBindings(session.quote!, entries, changedCallMessage)
      let paidNow = false
      if ((session.phase === 'quoted' || session.phase === 'payment-reverted') && !fundedElsewhere) {
        let payment: RelayrPayment | undefined
        if (session.phase === 'payment-reverted') {
          // A quote that was paid before is paid again with exactly the option it
          // used, and only when the SDK's retry rule clears it.
          payment = relayrRetryOption(session.payments, quote.payment_info)
        } else {
          const payments = relayrPaymentOptions(quote, chains)
          if (!payments.length) throw new Error('Relayr returned no payment option in the destinations’ network family.')
          const fundingChain = await requireFundingChainSelection(payments.map(payment => ({ chainId: payment.chain, label: relayrPaymentLabel(payment) })), preferredPaymentChainId)
          payment = payments.find(item => item.chain === fundingChain)
          if (!payment) throw new Error('Choose one of the quoted funding chains.')
        }
        const chosen = payment
        /** The wallet holds the payment and has returned no hash for it. */
        let sending = false
        const recheck = async () => {
          assertAccount()
          await reverify()
        }
        try {
          const { hash } = await relayrPay({
            payment: chosen, account: session.account, bundleUuid: quote.bundle_uuid,
            destinationChainIds: chains, sent: session.payments ?? [], reverify: recheck,
            onSending: () => {
              session.phase = 'payment-sending'
              session.paymentChainId = chosen.chain
              // The wallet's payment has no hash yet, even when an earlier one reverted.
              delete session.paymentHash
              persist(true)
              sending = true
            },
            onSent: payments => {
              sending = false
              session.payments = payments
              session.paymentHash = payments[payments.length - 1].hash
              session.phase = 'executing'
              persist()
            },
          })
          session.paymentHash = hash
          session.phase = 'executing'
          persist()
          paidNow = true
        } catch (error) {
          const outcome = relayrPaymentAttemptOutcome(error, { sending, paid: !!session.payments?.length })
          if (outcome) {
            session.phase = outcome === 'reverted' ? 'payment-reverted' : 'quoted'
            persist()
          }
          const latest = session.payments?.at(-1)
          if (!(error instanceof RelayrPaymentSubmittedError) || session.phase !== 'executing' ||
              !latest || latest.hash.toLowerCase() !== error.hash.toLowerCase() || latest.chainId !== error.chainId ||
              session.paymentHash?.toLowerCase() !== error.hash.toLowerCase()) throw error
          // Only a durably saved submission continues into read-only reconciliation.
          persist(true)
        }
      }
      if (session.phase === 'payment-sending') throw new Error('The wallet funding result is uncertain. Keep the saved bundle pending; do not pay again.')
      if (!paidNow && session.phase === 'executing') {
        // A payment that reverted funded nothing: the quote waits on the retry rule.
        // A send with no hash yet stays as it is, since it may still land.
        const confirmed = await proveSavedRelayrPayment(relayrChainClient, session.payments, session.account, () => {
          session.phase = 'payment-reverted'
          persist()
        })
        if (!confirmed) throw new Error('The submitted Relayr payment cannot be confirmed yet. Keep the saved bundle pending; do not pay again.')
      }
      let pollError: unknown
      try {
        await relayrPoll(quote.bundle_uuid, entries.length, records => {
          session.records = records
          persist()
        }, 2_500, 60_000)
      } catch (error) { pollError = error }
  return pollError
}
