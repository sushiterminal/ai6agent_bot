import assert from "node:assert/strict";
import test from "node:test";
import type { JupiterQuote } from "../src/server/jupiter.js";
import {
  buildJupiterSwapTransaction,
  diagnoseSimulationError,
  getSolanaBalanceSnapshot,
  getSolanaTransactionOutcome,
  isSolanaBlockhashValid,
  sendSolanaTransactionOnce,
  simulateSolanaTransaction,
} from "../src/server/solana-simulation.js";

const quote: JupiterQuote = {
  inAmount: "200000000",
  outAmount: "183274",
  priceImpactPct: "0.001",
  routePlan: [{ swapInfo: { label: "Fixture" } }],
  quoteResponse: {
    inputMint: "USDC",
    outputMint: "MU",
    inAmount: "200000000",
    outAmount: "183274",
    priceImpactPct: "0.001",
    routePlan: [{ swapInfo: { label: "Fixture" } }],
  },
};

test("builds an unsigned Jupiter swap without exposing signing operations", async () => {
  let requestBody: any;
  const result = await buildJupiterSwapTransaction({
    quote,
    userPublicKey: "11111111111111111111111111111111",
    apiKey: "fixture-key",
    maxPriorityFeeLamports: 100_000,
    options: {
      timeoutMs: 1_000,
      maxRetries: 0,
      fetch: (async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          swapTransaction: "A".repeat(64),
          lastValidBlockHeight: 123,
          prioritizationFeeLamports: 999,
          computeUnitLimit: 200_000,
          simulationError: null,
        });
      }) as typeof fetch,
    },
  });
  assert.equal(requestBody.userPublicKey, "11111111111111111111111111111111");
  assert.equal(requestBody.prioritizationFeeLamports.priorityLevelWithMaxLamports.maxLamports, 100_000);
  assert.equal(result.lastValidBlockHeight, 123);
  assert.equal(result.computeUnitLimit, 200_000);
});

test("broadcasts once while allowing bounded RPC rebroadcasts of identical bytes", async () => {
  let calls = 0;
  let requestBody: any;
  const signature = "2".repeat(88);
  const result = await sendSolanaTransactionOnce({
    rpcUrl: "https://mainnet.helius-rpc.com/?api-key=fixture",
    transactionBase64: "A".repeat(64),
    options: {
      timeoutMs: 1_000,
      fetch: (async (_url, init) => {
        calls += 1;
        requestBody = JSON.parse(String(init?.body));
        return Response.json({ result: signature });
      }) as typeof fetch,
    },
  });
  assert.equal(calls, 1);
  assert.equal(result, signature);
  assert.equal(requestBody.method, "sendTransaction");
  assert.equal(requestBody.params[1].maxRetries, 3);
  assert.equal(requestBody.params[1].skipPreflight, false);
});

test("never retries an ambiguous Solana broadcast failure", async () => {
  let calls = 0;
  await assert.rejects(() => sendSolanaTransactionOnce({
    rpcUrl: "https://mainnet.helius-rpc.com/?api-key=fixture",
    transactionBase64: "A".repeat(64),
    options: {
      timeoutMs: 1_000,
      fetch: (async () => {
        calls += 1;
        throw new Error("timeout");
      }) as typeof fetch,
    },
  }), /timeout/);
  assert.equal(calls, 1);
});

test("reconciles a confirmed Solana signature and exact owner token delta", async () => {
  let calls = 0;
  const outcome = await getSolanaTransactionOutcome({
    rpcUrl: "https://mainnet.helius-rpc.com/?api-key=fixture",
    signature: "2".repeat(88),
    owner: "11111111111111111111111111111111",
    tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    options: {
      timeoutMs: 1_000,
      maxRetries: 0,
      fetch: (async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body));
        if (body.method === "getSignatureStatuses") {
          return Response.json({ result: { value: [{
            slot: 99,
            err: null,
            confirmationStatus: "finalized",
          }] } });
        }
        return Response.json({ result: {
          meta: {
            err: null,
            fee: 5_000,
            preTokenBalances: [{
              owner: "11111111111111111111111111111111",
              mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              uiTokenAmount: { amount: "20000000" },
            }],
            postTokenBalances: [{
              owner: "11111111111111111111111111111111",
              mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              uiTokenAmount: { amount: "1000000" },
            }],
          },
        } });
      }) as typeof fetch,
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(outcome, {
    state: "CONFIRMED",
    confirmationStatus: "finalized",
    slot: 99,
    error: null,
    feeLamports: 5_000,
    tokenDeltaRaw: "-19000000",
  });
});

test("does not treat an absent Solana signature as safe to resubmit", async () => {
  const outcome = await getSolanaTransactionOutcome({
    rpcUrl: "https://mainnet.helius-rpc.com/?api-key=fixture",
    signature: "2".repeat(88),
    owner: "11111111111111111111111111111111",
    tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    options: {
      timeoutMs: 1_000,
      maxRetries: 0,
      fetch: (async () => Response.json({ result: { value: [null] } })) as typeof fetch,
    },
  });
  assert.equal(outcome.state, "NOT_FOUND");
  assert.equal(outcome.tokenDeltaRaw, null);
});

test("proves a missing submission expired only after its blockhash becomes invalid", async () => {
  const requests: any[] = [];
  const valid = await isSolanaBlockhashValid({
    rpcUrl: "https://mainnet.helius-rpc.com/?api-key=fixture",
    blockhash: "11111111111111111111111111111111",
    options: {
      timeoutMs: 1_000,
      maxRetries: 0,
      fetch: (async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({ result: { context: { slot: 42 }, value: false } });
      }) as typeof fetch,
    },
  });
  assert.equal(valid, false);
  assert.equal(requests[0]?.method, "isBlockhashValid");
  assert.deepEqual(requests[0]?.params, [
    "11111111111111111111111111111111",
    { commitment: "confirmed" },
  ]);
});

test("simulates with signature verification disabled and blockhash replacement", async () => {
  let requestBody: any;
  const result = await simulateSolanaTransaction({
    rpcUrl: "https://mainnet.helius-rpc.com/?api-key=fixture",
    transactionBase64: "A".repeat(64),
    options: {
      timeoutMs: 1_000,
      maxRetries: 0,
      fetch: (async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          jsonrpc: "2.0",
          id: "test",
          result: {
            context: { slot: 42 },
            value: {
              err: null,
              logs: ["Program success"],
              unitsConsumed: 12345,
              loadedAccountsDataSize: 999,
              replacementBlockhash: { blockhash: "new", lastValidBlockHeight: 100 },
            },
          },
        });
      }) as typeof fetch,
    },
  });
  assert.equal(requestBody.method, "simulateTransaction");
  assert.equal(requestBody.params[1].sigVerify, false);
  assert.equal(requestBody.params[1].replaceRecentBlockhash, true);
  assert.equal(result.err, null);
  assert.equal(result.unitsConsumed, 12345);
});

test("does not retry ordinary simulation client errors", async () => {
  let calls = 0;
  await assert.rejects(() => simulateSolanaTransaction({
    rpcUrl: "https://mainnet.helius-rpc.com/?api-key=fixture",
    transactionBase64: "A".repeat(64),
    options: {
      timeoutMs: 1_000,
      maxRetries: 2,
      fetch: (async () => {
        calls += 1;
        return new Response("bad request", { status: 400 });
      }) as typeof fetch,
    },
  }), /returned 400/);
  assert.equal(calls, 1);
});

test("reads SOL and token balances without requiring private credentials", async () => {
  const result = await getSolanaBalanceSnapshot({
    rpcUrl: "https://mainnet.helius-rpc.com/?api-key=fixture",
    owner: "11111111111111111111111111111111",
    tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    options: {
      timeoutMs: 1_000,
      maxRetries: 0,
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "getBalance") {
          return Response.json({ result: { value: 1_500_000_000 } });
        }
        return Response.json({
          result: {
            value: [{
              account: {
                data: {
                  parsed: { info: { tokenAmount: { amount: "250000000", decimals: 6 } } },
                },
              },
            }],
          },
        });
      }) as typeof fetch,
    },
  });
  assert.equal(result.solLamports, 1_500_000_000);
  assert.equal(result.tokenRawAmount, "250000000");
  assert.equal(result.tokenUiAmount, 250);
});

test("decodes Jupiter insufficient funds error 6024", () => {
  assert.deepEqual(
    diagnoseSimulationError(null, { InstructionError: [3, { Custom: 6024 }] }),
    {
      code: 6024,
      name: "InsufficientFunds",
      message: "Insufficient funds for the swap amount, transaction fee, or account rent",
    },
  );
});
