import type { BackpackClient, BackpackHistoricalOrder } from "./backpack.js";
import { sendSolanaTransactionOnce } from "./solana-simulation.js";
import { CANARY_SIZE } from "./types.js";
import { Decimal } from "decimal.js";

export interface SupervisedExecutionGate {
  killSwitch: boolean;
  executionEnabled: boolean;
}

export function expectedExecutionApproval(tradeId: string) {
  return `EXECUTE $${CANARY_SIZE} ${tradeId}`;
}

export function assertSupervisedExecution(input: {
  gate: SupervisedExecutionGate;
  tradeId: string;
  approval: string;
}) {
  const failures = [
    ...(input.gate.killSwitch ? ["killSwitch"] : []),
    ...(!input.gate.executionEnabled ? ["executionDisabled"] : []),
    ...(input.approval !== expectedExecutionApproval(input.tradeId) ? ["approvalMismatch"] : []),
  ];
  if (failures.length > 0) {
    throw new Error(`Canary write blocked: ${failures.join(",")}`);
  }
}

export function buildIocLimitPreview(input: {
  side: "Bid" | "Ask";
  bestPrice: string;
  tickSize: string;
  slippagePct: number;
}) {
  const best = new Decimal(input.bestPrice);
  const tick = new Decimal(input.tickSize);
  const slippage = new Decimal(input.slippagePct).div(100);
  if (!best.isFinite() || best.lte(0) || !tick.isFinite() || tick.lte(0)) {
    throw new Error("IOC preview requires positive price and tick size");
  }
  if (!slippage.isFinite() || slippage.lt(0) || slippage.gte(1)) {
    throw new Error("IOC preview slippage must be between 0% and 100%");
  }
  const unrounded = input.side === "Ask"
    ? best.mul(new Decimal(1).minus(slippage))
    : best.mul(new Decimal(1).plus(slippage));
  const ticks = unrounded.div(tick);
  const limit = (input.side === "Ask" ? ticks.floor() : ticks.ceil()).mul(tick);
  return {
    orderType: "Limit" as const,
    timeInForce: "IOC" as const,
    side: input.side,
    bestPrice: best.toString(),
    worstPrice: limit.toString(),
    tickSize: tick.toString(),
    slippagePct: new Decimal(input.slippagePct).toString(),
  };
}

export class CanaryWriteAdapter {
  constructor(
    private readonly gate: SupervisedExecutionGate,
    private readonly backpack: Pick<BackpackClient, "executeIocLimitOrder">,
  ) {}

  async sendSpot(input: {
    tradeId: string;
    approval: string;
    rpcUrl: string;
    transactionBase64: string;
    timeoutMs: number;
  }) {
    assertSupervisedExecution({ gate: this.gate, ...input });
    return sendSolanaTransactionOnce({
      rpcUrl: input.rpcUrl,
      transactionBase64: input.transactionBase64,
      options: { timeoutMs: input.timeoutMs },
    });
  }

  async submitHedge(input: {
    tradeId: string;
    approval: string;
    clientId: number;
    symbol: string;
    quantity: string;
    worstPrice: string;
    reduceOnly?: boolean;
  }): Promise<BackpackHistoricalOrder> {
    assertSupervisedExecution({ gate: this.gate, ...input });
    return this.backpack.executeIocLimitOrder({
      clientId: input.clientId,
      symbol: input.symbol,
      side: input.reduceOnly ? "Bid" : "Ask",
      quantity: input.quantity,
      price: input.worstPrice,
      reduceOnly: input.reduceOnly,
    });
  }
}
