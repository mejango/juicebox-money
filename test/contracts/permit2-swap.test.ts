import { buildUniswapV4ExactInputSwapTx } from "@bananapus/nana-sdk-core/v6";
import { zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  addPermit2SignatureToSwap,
  permit2SignatureNeedsOnchainFallback,
  permit2TypedData,
  type Permit2SignatureAuthorization,
} from "@/lib/permit2-swap";

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const OUTPUT = "0x2222222222222222222222222222222222222222" as Address;
const RECIPIENT = "0x3333333333333333333333333333333333333333" as Address;
const HOOK = "0x4444444444444444444444444444444444444444" as Address;
const SIGNATURE = `0x${"55".repeat(65)}` as Hex;

function fixture() {
  const request = buildUniswapV4ExactInputSwapTx({
    chainId: 8453,
    poolKey: {
      currency0: TOKEN,
      currency1: OUTPUT,
      fee: 10_000,
      tickSpacing: 200,
      hooks: HOOK,
    },
    zeroForOne: true,
    amountIn: 25_000_000n,
    minimumAmountOut: 100n,
    recipient: RECIPIENT,
    deadline: 1_800_000_000n,
  });
  const authorization: Permit2SignatureAuthorization = {
    chainId: 8453,
    token: TOKEN,
    spender: request.address,
    amount: 25_000_000n,
    expiration: 1_799_999_900,
    nonce: 7,
    sigDeadline: 1_799_999_900n,
  };
  return { request, authorization };
}

describe("Permit2 direct-pay signatures", () => {
  it("prepends the reviewed PermitSingle to the exact V4 swap", () => {
    const { request, authorization } = fixture();
    const signed = addPermit2SignatureToSwap(request, authorization, SIGNATURE);
    const signedInputs = signed.args[1] as readonly Hex[];
    const originalInputs = request.args[1] as readonly Hex[];

    expect(signed.args[0]).toBe("0x0a10");
    expect(signedInputs).toHaveLength(2);
    expect(signedInputs[1]).toBe(originalInputs[0]);
    expect(signedInputs[0].toLowerCase()).toContain(SIGNATURE.slice(2).toLowerCase());
    expect(signed.args[2]).toBe(request.args[2]);
    expect(signed.value).toBe(0n);
    expect(permit2TypedData(authorization).message.details.nonce).toBe(7);
  });

  it("fails closed on a mismatched router and never falls back after rejection", () => {
    const { request, authorization } = fixture();
    expect(() =>
      addPermit2SignatureToSwap(
        request,
        { ...authorization, spender: zeroAddress },
        SIGNATURE,
      ),
    ).toThrow(/does not match/i);
    expect(
      permit2SignatureNeedsOnchainFallback({ code: 4001, message: "User rejected the request" }),
    ).toBe(false);
    expect(
      permit2SignatureNeedsOnchainFallback({ code: -32602, message: "Invalid parameters" }),
    ).toBe(true);
  });
});
