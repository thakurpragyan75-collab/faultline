/** Execution runner: pick an adapter, inject the schedule, verify, shrink, replay. */

import { mix, strHash } from "../keyed.ts";
import { randomScenario, targeted } from "../scenarios.ts";
import type { BugId, Fault, Hist, WorkItem } from "../types.ts";
import { raftAdapter } from "./raft-service.ts";
import { registerAdapter } from "./register-service.ts";
import type { Experiment, LiveReport, SystemAdapter, TargetId } from "./types.ts";
import { verifyObservation } from "./verify.ts";

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_TOKEN = 12_000;

const TARGETS: Record<string, true> = { "raft-service": true, "register-service": true };
const BUGS: Record<string, true> = {
  correct: true,
  B01: true,
  B02: true,
  B03: true,
  B04: true,
  B05: true,
  B06: true,
  B07: true,
  B11: true,
};

function adapterFor(id: TargetId): SystemAdapter {
  if (id === "register-service") return registerAdapter;
  return raftAdapter;
}

function hashOf(history: Hist[], detail: string): number {
  let x = 2166136261;
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (!h) continue;
    x = mix(x, h.start, h.end, strHash(h.op + ":" + h.key + ":" + h.value + ":" + h.result), h.client * 10 + h.seq);
  }
  return mix(x, strHash(detail), history.length, 0, 0) >>> 0;
}

/** Run one experiment through the connector and judge only the observation. */
export function runExperiment(experiment: Experiment): LiveReport {
  const obs = adapterFor(experiment.target).execute(experiment);
  const violation = verifyObservation(obs, experiment.maxTimeUs);
  return {
    violation,
    history: obs.history,
    notes: obs.notes,
    hash: hashOf(obs.history, violation?.detail ?? ""),
    events: obs.steps,
    runs: 1,
  };
}

function fails(experiment: Experiment): boolean {
  return runExperiment(experiment).violation !== null;
}

/** Drop faults while the service still fails. Calls stay: they are the observation. */
export function shrinkExperiment(experiment: Experiment): { experiment: Experiment; runs: number } {
  let runs = 1;
  if (!fails(experiment)) return { experiment, runs };
  let faults = experiment.faults.slice();
  let changed = true;
  while (changed && runs < 24) {
    changed = false;
    for (let i = 0; i < faults.length; i++) {
      const next = faults.slice(0, i).concat(faults.slice(i + 1));
      runs += 1;
      if (fails({ ...experiment, faults: next })) {
        faults = next;
        changed = true;
        break;
      }
      if (runs >= 24) break;
    }
  }
  return { experiment: { ...experiment, faults }, runs };
}

function fromScenario(target: TargetId, scenario: ReturnType<typeof targeted>[number]): Experiment {
  return {
    seed: scenario.seed,
    target,
    bug: scenario.bug,
    nodes: scenario.nodes,
    electionBonusUs: scenario.electionBonusUs.slice(),
    tightElection: scenario.tightElection,
    faults: scenario.faults.map((fault) => ({ ...fault })),
    calls: scenario.workload.map((item) => ({ ...item })),
    maxTimeUs: scenario.maxTimeUs,
  };
}

/** The aimed Raft schedule for this build. Correct uses the harsh self-quorum schedule with the bug removed. */
export function raftExperiment(bug: BugId): Experiment {
  if (bug === "correct") {
    const harsh = targeted("B03")[0];
    if (!harsh) return fromScenario("raft-service", randomScenario("correct", 1));
    return fromScenario("raft-service", { ...harsh, bug: "correct" });
  }
  const aimed = targeted(bug)[0];
  if (aimed) return fromScenario("raft-service", aimed);
  return fromScenario("raft-service", randomScenario(bug, 1));
}

/**
 * Register preset. Only B05 is a defective build; every other chip runs the correct register
 * under the same crash, so a clean result means that process kept the write.
 */
export function registerExperiment(bug: BugId): Experiment {
  return {
    seed: 1,
    target: "register-service",
    bug: bug === "B05" ? "B05" : "correct",
    nodes: 1,
    electionBonusUs: [0],
    tightElection: false,
    faults: [{ kind: "crash", node: 0, at: 60_000, until: 200_000 }],
    calls: [
      { at: 50_000, client: 0, seq: 1, node: 0, op: "put", key: "a", value: "1" },
      { at: 300_000, client: 1, seq: 1, node: 0, op: "get", key: "a", value: "" },
    ],
    maxTimeUs: 400_000,
  };
}

function encodeJson(json: string): string {
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

function decodeJson(text: string): unknown {
  const map: Record<string, number> = {};
  for (let i = 0; i < ALPHA.length; i++) {
    const ch = ALPHA[i];
    if (ch) map[ch] = i;
  }
  let bits = 0;
  let acc = 0;
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!ch || map[ch] === undefined) return null;
    acc = (acc << 6) | (map[ch] ?? 0);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 255);
    }
  }
  let json = "";
  for (let i = 0; i < bytes.length; i++) json += String.fromCharCode(bytes[i] ?? 0);
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

function isToken(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length <= max && /^[\x20-\x7e]*$/.test(v);
}

function toExperiment(v: unknown): Experiment | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.target !== "string" || !TARGETS[o.target]) return null;
  if (typeof o.bug !== "string" || !BUGS[o.bug]) return null;
  if (!isInt(o.nodes, 1, 5) || !isInt(o.seed, 0, 1_000_000_000)) return null;
  if (!Array.isArray(o.electionBonusUs) || o.electionBonusUs.length !== o.nodes) return null;
  const electionBonusUs: number[] = [];
  for (let i = 0; i < o.electionBonusUs.length; i++) {
    const bonus = o.electionBonusUs[i];
    if (!isInt(bonus, 0, 10_000_000)) return null;
    electionBonusUs.push(bonus);
  }
  if (typeof o.tightElection !== "boolean") return null;
  if (!Array.isArray(o.faults) || o.faults.length > 32) return null;
  if (!Array.isArray(o.calls) || o.calls.length > 48) return null;
  if (!isInt(o.maxTimeUs, 1, 30_000_000)) return null;
  const faults: Fault[] = [];
  for (let i = 0; i < o.faults.length; i++) {
    const fault = o.faults[i];
    if (!fault || typeof fault !== "object") return null;
    const f = fault as Record<string, unknown>;
    if (!isInt(f.at, 0, 30_000_000) || !isInt(f.until, 0, 30_000_000) || f.until < f.at) return null;
    if (f.kind === "crash" || f.kind === "isolate" || f.kind === "mute") {
      if (!isInt(f.node, 0, o.nodes - 1)) return null;
      faults.push({ kind: f.kind, node: f.node, at: f.at, until: f.until });
    } else if (f.kind === "cut") {
      if (!isInt(f.a, 0, o.nodes - 1) || !isInt(f.b, 0, o.nodes - 1) || f.a === f.b) return null;
      faults.push({ kind: "cut", a: f.a, b: f.b, at: f.at, until: f.until });
    } else return null;
  }
  const calls: WorkItem[] = [];
  for (let i = 0; i < o.calls.length; i++) {
    const call = o.calls[i];
    if (!call || typeof call !== "object") return null;
    const c = call as Record<string, unknown>;
    if (!isInt(c.at, 0, 30_000_000) || !isInt(c.client, 0, 32) || !isInt(c.seq, 1, 10_000)) return null;
    if (!isInt(c.node, 0, o.nodes - 1)) return null;
    if (c.op !== "put" && c.op !== "get" && c.op !== "add") return null;
    if (!isToken(c.key, 12) || c.key.length === 0 || !isToken(c.value, 16)) return null;
    calls.push({ at: c.at, client: c.client, seq: c.seq, node: c.node, op: c.op, key: c.key, value: c.value });
  }
  return {
    seed: o.seed,
    target: o.target as TargetId,
    bug: o.bug as BugId,
    nodes: o.nodes,
    electionBonusUs,
    tightElection: o.tightElection,
    faults,
    calls,
    maxTimeUs: o.maxTimeUs,
  };
}

export function encodeExperiment(experiment: Experiment): string {
  return encodeJson(JSON.stringify(experiment));
}

export function decodeExperiment(text: string): Experiment | null {
  if (text.length === 0 || text.length > MAX_TOKEN) return null;
  return toExperiment(decodeJson(text));
}
