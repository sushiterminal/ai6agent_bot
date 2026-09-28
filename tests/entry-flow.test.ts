import assert from "node:assert/strict";
import test from "node:test";
import { runSupervisedEntryFlow, type SupervisedEntryFlowDependencies } from "../src/server/entry-flow.js";
import { createTradeIntent, type TradeIntent } from "../src/server/trade-intents.js";

function at(status: TradeIntent["status"], version: number): TradeIntent {
  return {
    ...createTradeIntent({
      tradeId: "trade-1",
      idempotencyKey: "operator:SPCX:flow-1",
      pair: "SPCX",
      basisRisk: "same_issuer",
    }),
    status,
    version,
  };
}

function scenario(start: TradeIntent) {
  let current = start;
  const calls: string[] = [];
  const dependencies: SupervisedEntryFlowDependencies = {
    reload: async () => { calls.push("reload"); return current; },
    executeSpot: async () => {
      calls.push("executeSpot");
      current = at("SPOT_SUBMITTED", current.version + 1);
      return { tradeId: current.tradeId, status: "SPOT_SUBMITTED", externalId: "sig", requiresReconciliation: true };
    },
    confirmSpot: async () => {
      calls.push("confirmSpot");
      current = { ...at("SPOT_CONFIRMED", current.version + 1), spotFilledQuantity: "0.12" };
      return current;
    },
    executeHedge: async () => {
      calls.push("executeHedge");
      current = at("HEDGE_SUBMITTED", current.version + 1);
      return { tradeId: current.tradeId, status: "HEDGE_SUBMITTED", externalId: "order", requiresReconciliation: true };
    },
    confirmHedge: async () => {
      calls.push("confirmHedge");
      current = at("OPEN", current.version + 2);
      return current;
    },
    finalizeHedged: async () => {
      calls.push("finalizeHedged");
      current = at("OPEN", current.version + 1);
      return current;
    },
    markSpotOnly: async (_intent, error) => {
      calls.push(`markSpotOnly:${error.message}`);
      current = { ...at("SPOT_ONLY", current.version + 1), lastError: error.message };
      return current;
    },
  };
  return { dependencies, calls, current: () => current };
}

test("runs the complete supervised entry sequence", async () => {
  const fixture = scenario(at("APPROVED", 2));
  const result = await runSupervisedEntryFlow({
    intent: fixture.current(),
    dependencies: fixture.dependencies,
  });
  assert.equal(result.status, "OPEN");
  assert.deepEqual(fixture.calls, [
    "executeSpot", "reload", "confirmSpot", "executeHedge", "reload", "confirmHedge",
  ]);
});

test("restart from submitted states reconciles without duplicate writes", async () => {
  const spot = scenario(at("SPOT_SUBMITTED", 3));
  await runSupervisedEntryFlow({ intent: spot.current(), dependencies: spot.dependencies });
  assert.equal(spot.calls.includes("executeSpot"), false);
  assert.deepEqual(spot.calls, ["confirmSpot", "executeHedge", "reload", "confirmHedge"]);

  const hedge = scenario(at("HEDGE_SUBMITTED", 6));
  await runSupervisedEntryFlow({ intent: hedge.current(), dependencies: hedge.dependencies });
  assert.equal(hedge.calls.includes("executeSpot"), false);
  assert.equal(hedge.calls.includes("executeHedge"), false);
  assert.deepEqual(hedge.calls, ["confirmHedge"]);

  const confirmedHedge = scenario(at("HEDGED", 7));
  const result = await runSupervisedEntryFlow({
    intent: confirmedHedge.current(),
    dependencies: confirmedHedge.dependencies,
  });
  assert.equal(result.status, "OPEN");
  assert.deepEqual(confirmedHedge.calls, ["finalizeHedged"]);
});

test("stops immediately when spot confirmation is uncertain", async () => {
  const fixture = scenario(at("SPOT_SUBMITTED", 3));
  fixture.dependencies.confirmSpot = async () => {
    fixture.calls.push("confirmSpot");
    return at("UNCERTAIN", 4);
  };
  const result = await runSupervisedEntryFlow({
    intent: fixture.current(),
    dependencies: fixture.dependencies,
  });
  assert.equal(result.status, "UNCERTAIN");
  assert.deepEqual(fixture.calls, ["confirmSpot"]);
});

test("records spot-only exposure when hedge preparation fails", async () => {
  const fixture = scenario({ ...at("SPOT_CONFIRMED", 4), spotFilledQuantity: "0.12" });
  fixture.dependencies.executeHedge = async () => {
    fixture.calls.push("executeHedge");
    throw new Error("no hedge capacity");
  };
  const result = await runSupervisedEntryFlow({
    intent: fixture.current(),
    dependencies: fixture.dependencies,
  });
  assert.equal(result.status, "SPOT_ONLY");
  assert.match(result.lastError ?? "", /no hedge capacity/);
  assert.deepEqual(fixture.calls, ["executeHedge", "reload", "markSpotOnly:no hedge capacity"]);
});
