import { createHash } from "node:crypto";
import { CANARY_SIZE, type PairSymbol } from "./types.js";

export interface CanaryApprovalPreview {
  tradeId: string;
  pair: PairSymbol;
  basisRisk: "same_issuer" | "cross_issuer";
  sizeUsd: typeof CANARY_SIZE;
  createdAt: Date;
  expiresAt: Date;
  spot: {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    minimumOutAmount: string;
    priceImpactPct: string;
    route: string[];
    quoteResponse: Record<string, unknown>;
    simulationPassed: boolean;
    priorityFeeLamports: number;
  };
  hedge: {
    symbol: string;
    quantity: string;
    bestBid: string;
    worstPrice: string;
    tickSize: string;
    timeInForce: "IOC";
    preflightPassed: boolean;
  };
  economics: {
    entryEdgePct: number;
    immediateLiquidationPnlUsd: number;
    worstCaseLossUsd: number;
  };
  risk: {
    pass: boolean;
    failures: string[];
    gates: Record<string, boolean>;
  };
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function fingerprintCanaryPreview(preview: CanaryApprovalPreview) {
  return createHash("sha256").update(JSON.stringify(canonical(preview))).digest("hex");
}

export function expectedApprovalText(tradeId: string, fingerprint: string) {
  return `APPROVE $${CANARY_SIZE} ${tradeId} ${fingerprint}`;
}

export function assertCanaryApproval(input: {
  preview: CanaryApprovalPreview;
  fingerprint: string;
  approval: string;
  now?: Date;
}) {
  assertCanaryPreviewReady(input);
  if (input.approval !== expectedApprovalText(input.preview.tradeId, input.fingerprint)) {
    throw new Error("Canary approval text mismatch");
  }
}

export function assertCanaryPreviewReady(input: {
  preview: CanaryApprovalPreview;
  fingerprint: string;
  now?: Date;
}) {
  assertCanaryPreviewIntegrity(input);
  if ((input.now ?? new Date()).getTime() >= input.preview.expiresAt.getTime()) {
    throw new Error("Canary preview has expired");
  }
}

export function assertCanaryPreviewIntegrity(input: {
  preview: CanaryApprovalPreview;
  fingerprint: string;
}) {
  const actualFingerprint = fingerprintCanaryPreview(input.preview);
  if (input.fingerprint !== actualFingerprint) throw new Error("Canary preview fingerprint mismatch");
  if (!input.preview.spot.simulationPassed) throw new Error("Solana simulation did not pass");
  if (!input.preview.hedge.preflightPassed) throw new Error("Backpack preflight did not pass");
  if (!input.preview.risk.pass) throw new Error("Canary risk policy did not pass");
}

export function publicCanaryPreview(preview: CanaryApprovalPreview) {
  const { quoteResponse: _quoteResponse, ...spot } = preview.spot;
  return { ...preview, spot };
}
