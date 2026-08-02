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
