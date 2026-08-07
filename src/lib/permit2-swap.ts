import type { TxRequest } from "@/hooks/useSafeTx";
import { addPermit2SignatureToDirectPaySwap } from "@bananapus/nana-sdk-core/v6/direct-pay";
import {
  PERMIT2_ADDRESS,
  permit2SignatureNeedsOnchainFallback,
  permit2TypedData,
  shouldUsePermit2Signature,
  type Permit2SignatureAuthorization,
} from "@bananapus/nana-sdk-core/v6/permit2";
import type { Hex } from "viem";

export {
  PERMIT2_ADDRESS,
  permit2SignatureNeedsOnchainFallback,
  permit2TypedData,
  shouldUsePermit2Signature,
  type Permit2SignatureAuthorization,
};

/** Adapt the app's reviewed transaction shape to the SDK's exact swap shape. */
export function addPermit2SignatureToSwap(
  request: TxRequest,
  authorization: Permit2SignatureAuthorization,
  signature: Hex,
): TxRequest {
  return addPermit2SignatureToDirectPaySwap(
    request as Parameters<typeof addPermit2SignatureToDirectPaySwap>[0],
    authorization,
    signature,
  ) as TxRequest;
}

/**
 * Whether the payment sequence is in flight and must not offer retry or close.
 *
 * `pendingHash` is set when the receipt wait gives up (~5 min): the payment was
 * SUBMITTED, not failed, so a second `pay` would be a genuine double payment.
 * The in-flight flag alone is cleared in the sequence's `finally`, which is why
 * the pending hash has to be part of the gate.
 */
export function paymentSequenceLocked(
  started: boolean,
  pendingHash: Hex | null,
): boolean {
  return started || pendingHash !== null;
}
