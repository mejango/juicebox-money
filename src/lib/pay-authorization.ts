import type { JBChainId } from '@bananapus/nana-sdk-core'
import {
  PERMIT2_PAY_AUTHORIZATION_SECONDS,
  addPermit2PayMetadata,
  type Permit2SignatureAuthorization,
} from '@bananapus/nana-sdk-core/v6'
import type { Address, Hex } from 'viem'
import { loadReviewEngine, loadReviewedSendDeps } from '@/lib/preload-review'
import { captureWalletContext } from '@/lib/wallet-context'
import { connectedWallet } from '@/lib/wallet-core'
import { wagmiConfig } from '@/providers/Providers'

const ACCOUNT_CHANGED = 'Connected account changed. Review the payment again.'

/** A signed pay authorization lasts 30 minutes; one this close to its deadline is signed again. */
const REUSE_MARGIN_SECONDS = 120

/** A payment's signed Permit2 allowance, kept while its run retries. */
export type SignedPayAuthorization = {
  authorization: Permit2SignatureAuthorization
  signature: Hex
}

/** Whether a signature from an earlier attempt still authorizes this exact payment. */
export function payAuthorizationReusable(
  signed: SignedPayAuthorization | null,
  fresh: Permit2SignatureAuthorization,
): signed is SignedPayAuthorization {
  if (!signed) return false
  const was = signed.authorization
  return (
    was.chainId === fresh.chainId &&
    was.token.toLowerCase() === fresh.token.toLowerCase() &&
    was.spender.toLowerCase() === fresh.spender.toLowerCase() &&
    was.amount === fresh.amount &&
    // Permit2 moves the nonce on when an allowance is used: an older one can no longer be spent.
    was.nonce === fresh.nonce &&
    // A fresh authorization expires a fixed time after the chain's latest block, so this compares against chain time.
    was.sigDeadline >=
      fresh.sigDeadline - BigInt(PERMIT2_PAY_AUTHORIZATION_SECONDS - REUSE_MARGIN_SECONDS)
  )
}

/**
 * The payer signs the exact, expiring Permit2 allowance for one payment. Core
 * shows the allowance and signs it; nothing moves until the payment that
 * carries it is sent.
 */
export async function signPayAuthorization(
  authorization: Permit2SignatureAuthorization,
  account: Address,
): Promise<SignedPayAuthorization> {
  const chainId = authorization.chainId as JBChainId
  // The typed data names its chain: the wallet signs it from that chain.
  await connectedWallet(chainId, { expected: account, changedError: ACCOUNT_CHANGED })
  const assertWallet = captureWalletContext(wagmiConfig, {
    account,
    chainId,
    message: ACCOUNT_CHANGED,
  })
  const { signReviewed } = await loadReviewEngine()
  const reviewedSendDeps = await loadReviewedSendDeps()
  const [signature] = await signReviewed(
    [{ kind: 'permit2', authorization }],
    {
      account,
      title: 'Authorize the payment',
      description:
        'Your signature lets this payment, and only this payment, take the exact amount. It costs no gas and expires in 30 minutes.',
      reverify: async () => assertWallet(),
    },
    reviewedSendDeps,
  )
  assertWallet()
  return { authorization, signature }
}

/** Pay metadata carrying the signed allowance, keyed to the entry that spends it. */
export function withPayAuthorization(
  metadata: Hex | undefined,
  signed: SignedPayAuthorization,
): Hex {
  return addPermit2PayMetadata({ metadata, ...signed })
}
