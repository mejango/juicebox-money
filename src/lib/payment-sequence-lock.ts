import type { Hex } from "viem";

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
