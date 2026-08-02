import { buildUniswapV4ExactInputSwapTx } from "@bananapus/nana-sdk-core/v6";
import { zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  addPermit2SignatureToSwap,
  permit2SignatureNeedsOnchainFallback,
  permit2TypedData,
  shouldUsePermit2Signature,
  type Permit2SignatureAuthorization,
} from "@/lib/permit2-swap";
import {
  buildDirectPaySwapTx,
  type DirectPaySwapQuote,
} from "@/lib/direct-pay-swap";

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const OUTPUT = "0x2222222222222222222222222222222222222222" as Address;
const RECIPIENT = "0x3333333333333333333333333333333333333333" as Address;
const HOOK = "0x4444444444444444444444444444444444444444" as Address;
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
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

  it("prefers a gasless signature when an EOA bytecode lookup fails", () => {
    expect(
      shouldUsePermit2Signature({
        needsApproval: true,
        walletLookupSettled: true,
        walletBytecode: undefined,
        isSafe: false,
      }),
    ).toBe(true);
    expect(
      shouldUsePermit2Signature({
        needsApproval: true,
        walletLookupSettled: true,
        walletBytecode: "0x6000",
        isSafe: false,
      }),
    ).toBe(false);
    expect(
      shouldUsePermit2Signature({
        needsApproval: true,
        walletLookupSettled: true,
        walletBytecode: undefined,
        isSafe: true,
      }),
    ).toBe(false);
  });

  it("prepends Permit2 without changing a reviewed USDC to ETH to V4 route", () => {
    const quote: DirectPaySwapQuote = {
      poolKey: {
        currency0: zeroAddress,
        currency1: OUTPUT,
        fee: 10_000,
        tickSpacing: 200,
        hooks: HOOK,
      },
      zeroForOne: true,
      quotedTokenCount: 101n,
      minimumTokenCount: 100n,
      inputRoute: {
        kind: "erc20-v3-native-v4",
        inputToken: BASE_USDC,
        wrappedNative: "0x4200000000000000000000000000000000000006",
        bridgeTokenSymbol: "ETH",
        bridgeTokenDecimals: 18,
        v3Fee: 500,
        quotedBridgeAmount: 10_000_000_000_000_000n,
      },
    };
    const request = buildDirectPaySwapTx({
      chainId: 8453,
      quote,
      amount: 25_000_000n,
      recipient: RECIPIENT,
      deadline: 1_800_000_000n,
    });
    const authorization: Permit2SignatureAuthorization = {
      chainId: 8453,
      token: BASE_USDC,
      spender: request.address,
      amount: 25_000_000n,
      expiration: 1_799_999_900,
      nonce: 7,
      sigDeadline: 1_799_999_900n,
    };
    const signed = addPermit2SignatureToSwap(request, authorization, SIGNATURE);

    expect(signed.args[0]).toBe("0x0a000c10");
    expect(signed.args[1]).toHaveLength(4);
    expect(signed.value).toBe(0n);
  });
});
