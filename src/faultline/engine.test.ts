import assert from "node:assert/strict";
import { test } from "node:test";
import { ZOO } from "./bugs.ts";
import { checkLinear } from "./check.ts";
import { narrate } from "./index.ts";
import { candidates, decodeReplay, encodeReplay, shrinkScenario } from "./scenarios.ts";
import type { BugId, Hist } from "./types.ts";
import { runScenario } from "./world.ts";

const FAULTS: BugId[] = ["B01", "B02", "B03", "B04", "B05", "B06", "B07", "B11"];

test("every zoo bug is found by the portfolio", () => {
  for (const bug of FAULTS) {
    const list = candidates(bug);
    let found = false;
    let trials = 0;
    for (const scenario of list) {
      trials += 1;
      const outcome = runScenario(scenario, "fast");
      if (outcome.violation) {
        found = true;
        break;
      }
      if (trials >= 20) break;
    }
    assert.equal(found, true, bug + " not found in " + trials + " trials");
  }
});

test("correct raft survives aimed templates and random scenarios", () => {
  const list = candidates("correct");
  for (let i = 0; i < list.length; i++) {
    const scenario = list[i];
    if (!scenario) continue;
    const outcome = runScenario(scenario, "fast");
    assert.equal(
      outcome.violation,
      null,
      "false positive seed " + scenario.seed + " " + (outcome.violation?.detail ?? ""),
    );
  }
});

test("fast and record modes share a hash", () => {
  const scenario = candidates("B03")[0];
  assert.ok(scenario);
  const fast = runScenario(scenario, "fast");
  const recorded = runScenario(scenario, "record");
  const again = runScenario(scenario, "fast");
  assert.equal(fast.hash, recorded.hash);
  assert.equal(fast.hash, again.hash);
  assert.ok(recorded.frames.length > 0);
  assert.equal(fast.frames.length, 0);
});

test("shrink keeps the violation and replay ids round-trip", () => {
  const scenario = candidates("B07")[0];
  assert.ok(scenario);
  const shrunk = shrinkScenario(scenario);
  const outcome = runScenario(shrunk.scenario, "record");
  assert.ok(outcome.violation, "shrunk scenario went quiet");
  const id = encodeReplay(shrunk.scenario);
  const back = decodeReplay(id);
  assert.deepEqual(back, shrunk.scenario);
  const text = narrate("B07", outcome);
  assert.match(text, /event/);
});

test("catalog covers the zoo", () => {
  assert.equal(ZOO.length, 9);
});

function put(i: number): Hist {
  return {
    client: 0,
    seq: i,
    op: "put",
    key: "a",
    value: String(i),
    result: "ok",
    start: i * 10,
    end: i * 10 + 1,
  };
}

test("linearizability covers histories longer than ten operations", () => {
  const legal: Hist[] = [];
  for (let i = 1; i <= 12; i++) legal.push(put(i));
  assert.equal(checkLinear(legal, 0, 12), null);
  const illegal = legal.slice(0, 11);
  illegal.push({
    client: 1,
    seq: 1,
    op: "get",
    key: "a",
    value: "",
    result: "1",
    start: 200,
    end: 201,
  });
  const found = checkLinear(illegal, 0, 12);
  assert.equal(found?.kind, "linearizability");
});

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeRaw(json: string): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (let i = 0; i < json.length; i++) {
    acc = (acc << 8) | json.charCodeAt(i);
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHA[(acc >> bits) & 63] ?? "A";
    }
  }
  if (bits > 0) out += ALPHA[(acc << (6 - bits)) & 63] ?? "A";
  return out;
}

test("replay ids reject malformed payloads", () => {
  assert.equal(decodeReplay(""), null);
  assert.equal(decodeReplay("not a token!!!"), null);
  assert.equal(decodeReplay("A".repeat(9000)), null);
  const forged = encodeRaw(
    JSON.stringify({
      seed: 1,
      bug: "B99",
      nodes: 3,
      electionBonusUs: [0, 0, 0],
      tightElection: false,
      faults: [],
      workload: [],
      maxTimeUs: 1000,
    }),
  );
  assert.equal(decodeReplay(forged), null);
  const nan = encodeRaw(
    JSON.stringify({
      seed: 1.5,
      bug: "B03",
      nodes: 3,
      electionBonusUs: [0, 0, 0],
      tightElection: false,
      faults: [],
      workload: [],
      maxTimeUs: 1000,
    }),
  );
  assert.equal(decodeReplay(nan), null);
});
