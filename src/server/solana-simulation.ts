import type { JupiterQuote } from "./jupiter.js";
import { VersionedTransaction } from "@solana/web3.js";

const JUPITER_SWAP_URL = "https://api.jup.ag/swap/v1/swap";

class ExternalHttpError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

interface RequestOptions {
  fetch?: typeof fetch;
  timeoutMs: number;
  maxRetries?: number;
}

export interface JupiterSwapBuild {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
  computeUnitLimit: number | null;
  simulationError: unknown;
}

export interface SolanaSimulationResult {
  slot: number;
  err: unknown;
  logs: string[];
  unitsConsumed: number | null;
  loadedAccountsDataSize: number | null;
  replacementBlockhash: { blockhash: string; lastValidBlockHeight: number } | null;
}

export interface SolanaBalanceSnapshot {
  solLamports: number;
  tokenRawAmount: string;
  tokenDecimals: number;
  tokenUiAmount: number;
}

export interface SolanaTransactionOutcome {
  state: "NOT_FOUND" | "PENDING" | "FAILED" | "CONFIRMED";
  confirmationStatus: string | null;
  slot: number | null;
  error: unknown;
  feeLamports: number | null;
  tokenDeltaRaw: string | null;
}

export function solanaTransactionRecentBlockhash(transactionBase64: string) {
  try {
    return VersionedTransaction.deserialize(
      Buffer.from(transactionBase64, "base64"),
    ).message.recentBlockhash;
  } catch {
    throw new Error("Signed Solana transaction has no readable recent blockhash");
  }
}

export async function isSolanaBlockhashValid(input: {
  rpcUrl: string;
  blockhash: string;
  options: RequestOptions;
}) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.blockhash)) {
    throw new Error("Solana recent blockhash must be valid base58");
  }
  const rpcUrl = validatedRpcUrl(input.rpcUrl);
  const response = asRecord(await postJson(rpcUrl.toString(), {
    jsonrpc: "2.0",
    id: "stock-trade-bot-blockhash-validity",
    method: "isBlockhashValid",
    params: [input.blockhash, { commitment: "confirmed" }],
  }, {}, input.options), "Solana blockhash validity RPC");
  if (response.error) throw new Error("Solana blockhash validity RPC returned an error");
  const result = asRecord(response.result, "Solana blockhash validity result");
  if (typeof result.value !== "boolean") {
    throw new Error("Solana blockhash validity RPC returned an invalid result");
  }
  return result.value;
}

export function diagnoseSimulationError(jupiterError: unknown, rpcError: unknown) {
  let customCode: number | null = null;
  if (typeof rpcError === "object" && rpcError !== null) {
    const instructionError = (rpcError as Record<string, unknown>).InstructionError;
    if (Array.isArray(instructionError)) {
      const detail = instructionError[1];
      if (typeof detail === "object" && detail !== null) {
        const custom = (detail as Record<string, unknown>).Custom;
        if (typeof custom === "number") customCode = custom;
      }
    }
  }
  if (customCode === 6024) {
    return {
      code: 6024,
      name: "InsufficientFunds",
      message: "Insufficient funds for the swap amount, transaction fee, or account rent",
    };
  }
  if (jupiterError || rpcError) {
    return {
      code: customCode,
      name: "SimulationFailed",
      message: "The unsigned transaction failed during simulation; inspect simulation logs",
    };
  }
  return null;
}

function validatePublicKey(value: string): void {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    throw new Error("SOLANA_WALLET_PUBLIC_KEY must be a valid base58 public key");
  }
}

function validateSignature(value: string): void {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)) {
    throw new Error("Solana transaction signature must be valid base58");
  }
}

function validatedRpcUrl(value: string): URL {
  let rpcUrl: URL;
  try {
    rpcUrl = new URL(value);
  } catch {
    throw new Error("SOLANA_RPC_URL must be a valid URL");
  }
  if (rpcUrl.protocol !== "https:") throw new Error("SOLANA_RPC_URL must use HTTPS");
  return rpcUrl;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  options: RequestOptions,
) {
  const fetchImpl = options.fetch ?? fetch;
  const maxRetries = options.maxRetries ?? 2;
  let lastError: Error = new Error("External POST failed");
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      if (response.ok) return response.json() as Promise<unknown>;
      const httpError = new ExternalHttpError(
        `External simulation request returned ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
      if (!httpError.retryable) throw httpError;
      lastError = httpError;
    } catch (error) {
      if (error instanceof ExternalHttpError && !error.retryable) throw error;
      lastError = error instanceof Error ? error : new Error("External simulation request failed");
      if (attempt === maxRetries) break;
    }
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  throw lastError;
}

function asRecord(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error(`${source} returned invalid JSON`);
  return value as Record<string, unknown>;
}

export async function buildJupiterSwapTransaction(input: {
  quote: JupiterQuote;
  userPublicKey: string;
  apiKey: string | null;
  maxPriorityFeeLamports: number;
  options: RequestOptions;
}): Promise<JupiterSwapBuild> {
  validatePublicKey(input.userPublicKey);
  const response = asRecord(await postJson(
    JUPITER_SWAP_URL,
    {
      quoteResponse: input.quote.quoteResponse,
      userPublicKey: input.userPublicKey,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: input.maxPriorityFeeLamports,
          priorityLevel: "high",
        },
      },
    },
    input.apiKey ? { "x-api-key": input.apiKey } : {},
    input.options,
  ), "Jupiter swap");
  if (
    typeof response.swapTransaction !== "string"
    || response.swapTransaction.length < 32
    || !Number.isFinite(response.lastValidBlockHeight)
  ) {
    const message = typeof response.error === "string" ? `: ${response.error}` : "";
    throw new Error(`Jupiter returned an invalid swap transaction${message}`);
  }
  return {
    swapTransaction: response.swapTransaction,
    lastValidBlockHeight: Number(response.lastValidBlockHeight),
    prioritizationFeeLamports: Number(response.prioritizationFeeLamports ?? 0),
    computeUnitLimit: Number.isFinite(response.computeUnitLimit)
      ? Number(response.computeUnitLimit)
      : null,
    simulationError: response.simulationError ?? null,
  };
}

export async function simulateSolanaTransaction(input: {
  rpcUrl: string;
  transactionBase64: string;
  options: RequestOptions;
  sigVerify?: boolean;
  replaceRecentBlockhash?: boolean;
}): Promise<SolanaSimulationResult> {
  const rpcUrl = validatedRpcUrl(input.rpcUrl);
  const response = asRecord(await postJson(
    rpcUrl.toString(),
    {
      jsonrpc: "2.0",
      id: "stock-trade-bot-simulation",
      method: "simulateTransaction",
      params: [
        input.transactionBase64,
        {
          encoding: "base64",
          sigVerify: input.sigVerify ?? false,
          replaceRecentBlockhash: input.replaceRecentBlockhash ?? true,
          commitment: "processed",
          innerInstructions: true,
        },
      ],
    },
    {},
    input.options,
  ), "Solana RPC");
  if (response.error) {
    const error = asRecord(response.error, "Solana RPC error");
    throw new Error(`Solana RPC simulation failed (${String(error.code ?? "unknown")}): ${String(error.message ?? "unknown error")}`);
  }
  const result = asRecord(response.result, "Solana RPC simulation");
  const context = asRecord(result.context, "Solana RPC context");
  const value = asRecord(result.value, "Solana RPC value");
  return {
    slot: Number(context.slot),
    err: value.err ?? null,
    logs: Array.isArray(value.logs)
      ? value.logs.filter((line): line is string => typeof line === "string")
      : [],
    unitsConsumed: Number.isFinite(value.unitsConsumed) ? Number(value.unitsConsumed) : null,
    loadedAccountsDataSize: Number.isFinite(value.loadedAccountsDataSize)
      ? Number(value.loadedAccountsDataSize)
      : null,
    replacementBlockhash: typeof value.replacementBlockhash === "object"
      && value.replacementBlockhash !== null
      ? value.replacementBlockhash as SolanaSimulationResult["replacementBlockhash"]
      : null,
  };
}

export async function sendSolanaTransactionOnce(input: {
  rpcUrl: string;
  transactionBase64: string;
  maxRpcRetries?: number;
  options: Omit<RequestOptions, "maxRetries">;
}): Promise<string> {
  if (input.transactionBase64.length < 32) throw new Error("Signed Solana transaction is invalid");
  const rpcUrl = validatedRpcUrl(input.rpcUrl);
  const response = asRecord(await postJson(rpcUrl.toString(), {
    jsonrpc: "2.0",
    id: "stock-trade-bot-send",
    method: "sendTransaction",
    params: [input.transactionBase64, {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: input.maxRpcRetries ?? 3,
    }],
  }, {}, { ...input.options, maxRetries: 0 }), "Solana send RPC");
  if (response.error) {
    const error = asRecord(response.error, "Solana send RPC error");
    throw new Error(`Solana send RPC failed (${String(error.code ?? "unknown")}): ${String(error.message ?? "unknown error")}`);
  }
  if (typeof response.result !== "string") {
    throw new Error("Solana send RPC returned an invalid signature");
  }
  validateSignature(response.result);
  return response.result;
}

export async function getSolanaBalanceSnapshot(input: {
  rpcUrl: string;
  owner: string;
  tokenMint: string;
  options: RequestOptions;
}): Promise<SolanaBalanceSnapshot> {
  validatePublicKey(input.owner);
  validatePublicKey(input.tokenMint);
  const rpcUrl = validatedRpcUrl(input.rpcUrl);
  const [solResponse, tokenResponse] = await Promise.all([
    postJson(rpcUrl.toString(), {
      jsonrpc: "2.0",
      id: "stock-trade-bot-balance",
      method: "getBalance",
      params: [input.owner, { commitment: "processed" }],
    }, {}, input.options),
    postJson(rpcUrl.toString(), {
      jsonrpc: "2.0",
      id: "stock-trade-bot-token-balance",
      method: "getTokenAccountsByOwner",
      params: [
        input.owner,
        { mint: input.tokenMint },
        { encoding: "jsonParsed", commitment: "processed" },
      ],
    }, {}, input.options),
  ]);
  const sol = asRecord(solResponse, "Solana balance RPC");
  const solResult = asRecord(sol.result, "Solana balance result");
  const token = asRecord(tokenResponse, "Solana token balance RPC");
  const tokenResult = asRecord(token.result, "Solana token balance result");
  const accounts = Array.isArray(tokenResult.value) ? tokenResult.value : [];
  let tokenRawAmount = 0n;
  let tokenDecimals = 0;
  for (const account of accounts) {
    try {
      const accountRecord = asRecord(account, "Solana token account");
      const accountData = asRecord(accountRecord.account, "Solana token account data");
      const data = asRecord(accountData.data, "Solana parsed token data");
      const parsed = asRecord(data.parsed, "Solana parsed token account");
      const info = asRecord(parsed.info, "Solana token account info");
      const amount = asRecord(info.tokenAmount, "Solana token amount");
      if (typeof amount.amount === "string" && /^\d+$/.test(amount.amount)) {
        tokenRawAmount += BigInt(amount.amount);
      }
      if (typeof amount.decimals === "number" && Number.isInteger(amount.decimals)) {
        tokenDecimals = amount.decimals;
      }
    } catch {
      // Ignore malformed individual token accounts; the aggregate remains conservative.
    }
  }
  return {
    solLamports: Number(solResult.value ?? 0),
    tokenRawAmount: tokenRawAmount.toString(),
    tokenDecimals,
    tokenUiAmount: Number(tokenRawAmount) / 10 ** tokenDecimals,
  };
}

function tokenAmountForOwner(
  balances: unknown,
  owner: string,
  tokenMint: string,
): bigint {
  if (!Array.isArray(balances)) return 0n;
  let total = 0n;
  for (const value of balances) {
    if (typeof value !== "object" || value === null) continue;
    const balance = value as Record<string, unknown>;
    if (balance.owner !== owner || balance.mint !== tokenMint) continue;
    if (typeof balance.uiTokenAmount !== "object" || balance.uiTokenAmount === null) continue;
    const amount = (balance.uiTokenAmount as Record<string, unknown>).amount;
    if (typeof amount === "string" && /^\d+$/.test(amount)) total += BigInt(amount);
  }
  return total;
}

export async function getSolanaTransactionOutcome(input: {
  rpcUrl: string;
  signature: string;
  owner: string;
  tokenMint: string;
  options: RequestOptions;
}): Promise<SolanaTransactionOutcome> {
  validateSignature(input.signature);
  validatePublicKey(input.owner);
  validatePublicKey(input.tokenMint);
  const rpcUrl = validatedRpcUrl(input.rpcUrl);
  const statusResponse = asRecord(await postJson(rpcUrl.toString(), {
    jsonrpc: "2.0",
    id: "stock-trade-bot-signature-status",
    method: "getSignatureStatuses",
    params: [[input.signature], { searchTransactionHistory: true }],
  }, {}, input.options), "Solana signature status RPC");
  if (statusResponse.error) throw new Error("Solana signature status RPC returned an error");
  const statusResult = asRecord(statusResponse.result, "Solana signature status result");
  const statusValue = Array.isArray(statusResult.value) ? statusResult.value[0] : null;
  if (typeof statusValue !== "object" || statusValue === null) {
    return {
      state: "NOT_FOUND",
      confirmationStatus: null,
      slot: null,
      error: null,
      feeLamports: null,
      tokenDeltaRaw: null,
    };
  }
  const status = statusValue as Record<string, unknown>;
  const confirmationStatus = typeof status.confirmationStatus === "string"
    ? status.confirmationStatus
    : null;
  const slot = Number.isFinite(status.slot) ? Number(status.slot) : null;
  if (status.err !== null && status.err !== undefined) {
    return {
      state: "FAILED",
      confirmationStatus,
      slot,
      error: status.err,
      feeLamports: null,
      tokenDeltaRaw: null,
    };
  }
  if (confirmationStatus !== "confirmed" && confirmationStatus !== "finalized") {
    return {
      state: "PENDING",
      confirmationStatus,
      slot,
      error: null,
      feeLamports: null,
      tokenDeltaRaw: null,
    };
  }
  const transactionResponse = asRecord(await postJson(rpcUrl.toString(), {
    jsonrpc: "2.0",
    id: "stock-trade-bot-transaction",
    method: "getTransaction",
    params: [input.signature, {
      commitment: "confirmed",
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
    }],
  }, {}, input.options), "Solana transaction RPC");
  if (transactionResponse.error) throw new Error("Solana transaction RPC returned an error");
  if (typeof transactionResponse.result !== "object" || transactionResponse.result === null) {
    return {
      state: "PENDING",
      confirmationStatus,
      slot,
      error: null,
      feeLamports: null,
      tokenDeltaRaw: null,
    };
  }
  const transaction = transactionResponse.result as Record<string, unknown>;
  const meta = asRecord(transaction.meta, "Solana transaction metadata");
  if (meta.err !== null && meta.err !== undefined) {
    return {
      state: "FAILED",
      confirmationStatus,
      slot,
      error: meta.err,
      feeLamports: Number.isFinite(meta.fee) ? Number(meta.fee) : null,
      tokenDeltaRaw: null,
    };
  }
  const before = tokenAmountForOwner(meta.preTokenBalances, input.owner, input.tokenMint);
  const after = tokenAmountForOwner(meta.postTokenBalances, input.owner, input.tokenMint);
  return {
    state: "CONFIRMED",
    confirmationStatus,
    slot,
    error: null,
    feeLamports: Number.isFinite(meta.fee) ? Number(meta.fee) : null,
    tokenDeltaRaw: (after - before).toString(),
  };
}
