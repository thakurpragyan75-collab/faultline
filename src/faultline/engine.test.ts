import assert from "node:assert/strict";
import { test } from "node:test";
import { ZOO } from "./bugs.ts";
import { narrate } from "./index.ts";
import { candidates, decodeReplay, encodeReplay, shrinkScenario } from "./scenarios.ts";
import type { BugId } from "./types.ts";
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
