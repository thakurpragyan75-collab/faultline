import assert from "node:assert/strict";
import { test } from "node:test";
import type { BugId } from "../types.ts";
import {
  decodeExperiment,
  encodeExperiment,
  raftExperiment,
  registerExperiment,
  runExperiment,
  shrinkExperiment,
} from "./runner.ts";
import { randomScenario, targeted } from "../scenarios.ts";

const FAULTS: BugId[] = ["B01", "B02", "B03", "B04", "B05", "B06", "B07", "B11"];

test("live raft service fails every zoo bug and stays clean when correct", () => {
  for (const bug of FAULTS) {
    const aimed = targeted(bug);
    let found = false;
    const trials = aimed.length > 0 ? aimed : [randomScenario(bug, 1)];
    for (let i = 0; i < trials.length && i < 8; i++) {
      const scenario = trials[i];
      if (!scenario) continue;
      const report = runExperiment({
        seed: scenario.seed,
        target: "raft-service",
        bug: scenario.bug,
        nodes: scenario.nodes,
        electionBonusUs: scenario.electionBonusUs,
        tightElection: scenario.tightElection,
        faults: scenario.faults,
        calls: scenario.workload,
        maxTimeUs: scenario.maxTimeUs,
      });
      if (report.violation) {
        found = true;
        break;
      }
    }
    assert.equal(found, true, bug + " produced no live violation");
  }
  const clean = runExperiment(raftExperiment("correct"));
  assert.equal(clean.violation, null, clean.violation?.detail ?? "");
});

test("the same live experiment replays to the same hash", () => {
  const experiment = raftExperiment("B03");
  const first = runExperiment(experiment);
  const second = runExperiment(experiment);
  assert.ok(first.violation);
  assert.equal(first.hash, second.hash);
  assert.deepEqual(first.history, second.history);
  const back = decodeExperiment(encodeExperiment(experiment));
  assert.deepEqual(back, experiment);
});

test("shrinking a live failure keeps the violation", () => {
  const shrunk = shrinkExperiment(raftExperiment("B03"));
  const report = runExperiment(shrunk.experiment);
  assert.ok(report.violation, "shrunk live run went quiet");
  assert.ok(shrunk.experiment.faults.length <= raftExperiment("B03").faults.length);
});

test("register service loses an acked write only in the amnesia build", () => {
  const broken = runExperiment(registerExperiment("B05"));
  assert.equal(broken.violation?.kind, "linearizability");
  assert.match(broken.notes.join("\n"), /put a=1 → ok/);
  assert.match(broken.notes.join("\n"), /get a → empty/);
  const sound = runExperiment(registerExperiment("correct"));
  assert.equal(sound.violation, null, sound.violation?.detail ?? "");
  assert.match(sound.notes.join("\n"), /get a → 1/);
});

test("live replay tokens reject garbage", () => {
  assert.equal(decodeExperiment(""), null);
  assert.equal(decodeExperiment("$$$"), null);
  assert.equal(decodeExperiment("A".repeat(13000)), null);
});
