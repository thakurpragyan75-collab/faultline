/** Targeted scenarios, random portfolios, shrinking, and replay ids. */

import { keyed } from "./keyed.ts";
import type { BugId, Fault, Scenario, WorkItem } from "./types.ts";
import { runScenario } from "./world.ts";

const END = 1_600_000;

function sc(bug: BugId, extra: Omit<Scenario, "bug" | "nodes"> & { nodes?: number }): Scenario {
  return {
    bug,
    nodes: extra.nodes ?? 3,
    seed: extra.seed,
    electionBonusUs: extra.electionBonusUs,
    tightElection: extra.tightElection,
    faults: extra.faults,
    workload: extra.workload,
    maxTimeUs: extra.maxTimeUs,
  };
}

/** Hand-aimed scenarios. The hunter tries these before random seeds. */
export function targeted(bug: BugId): Scenario[] {
  if (bug === "B01" || bug === "B03") {
    return [
      sc(bug, {
        seed: 1,
        electionBonusUs: [0, 160_000, 160_000],
        tightElection: false,
        faults: [
          { kind: "mute", node: 0, at: 279_000, until: END },
          { kind: "crash", node: 0, at: 282_000, until: END },
        ],
        workload: [
          { at: 280_000, client: 0, seq: 1, node: 0, op: "put", key: "a", value: "1" },
          { at: 900_000, client: 1, seq: 1, node: 1, op: "get", key: "a", value: "" },
        ],
        maxTimeUs: END,
      }),
    ];
  }
  if (bug === "B02") {
    return [
      sc(bug, {
        seed: 3,
        electionBonusUs: [0, 200_000, 30_000],
        tightElection: false,
        faults: [
          { kind: "isolate", node: 2, at: 0, until: 420_000 },
          { kind: "crash", node: 0, at: 520_000, until: END },
        ],
        workload: [
          { at: 280_000, client: 0, seq: 1, node: 0, op: "put", key: "a", value: "9" },
          { at: 1_150_000, client: 1, seq: 1, node: 2, op: "get", key: "a", value: "" },
        ],
        maxTimeUs: END,
      }),
    ];
  }
  if (bug === "B04") {
    const out: Scenario[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      out.push(
        sc(bug, {
          seed,
          electionBonusUs: [0, 0, 0],
          tightElection: true,
          faults: [],
          workload: [{ at: 500_000, client: 0, seq: 1, node: seed % 3, op: "put", key: "a", value: "1" }],
          maxTimeUs: 900_000,
        }),
      );
    }
    return out;
  }
  if (bug === "B05") {
    return [
      sc(bug, {
        seed: 2,
        electionBonusUs: [0, 140_000, 140_000],
        tightElection: false,
        faults: [
          { kind: "crash", node: 0, at: 480_000, until: 700_000 },
          { kind: "crash", node: 1, at: 480_000, until: 700_000 },
          { kind: "crash", node: 2, at: 480_000, until: 700_000 },
        ],
        workload: [
          { at: 280_000, client: 0, seq: 1, node: 0, op: "put", key: "a", value: "5" },
          { at: 1_200_000, client: 1, seq: 1, node: 0, op: "get", key: "a", value: "" },
        ],
        maxTimeUs: END,
      }),
    ];
  }
  if (bug === "B06") {
    return [
      sc(bug, {
        seed: 4,
        electionBonusUs: [0, 80_000, 170_000],
        tightElection: false,
        faults: [{ kind: "isolate", node: 0, at: 460_000, until: END }],
        workload: [
          { at: 260_000, client: 0, seq: 1, node: 0, op: "put", key: "a", value: "1" },
          { at: 860_000, client: 2, seq: 1, node: 1, op: "put", key: "a", value: "2" },
          { at: 1_250_000, client: 1, seq: 1, node: 0, op: "get", key: "a", value: "" },
        ],
        maxTimeUs: END,
      }),
    ];
  }
  if (bug === "B07") {
    return [
      sc(bug, {
        seed: 1,
        electionBonusUs: [0, 150_000, 150_000],
        tightElection: false,
        faults: [],
        workload: [
          { at: 280_000, client: 0, seq: 1, node: 0, op: "put", key: "a", value: "1" },
          { at: 460_000, client: 0, seq: 2, node: 0, op: "put", key: "a", value: "2" },
          { at: 780_000, client: 1, seq: 1, node: 0, op: "get", key: "a", value: "" },
        ],
        maxTimeUs: 1_200_000,
      }),
    ];
  }
  if (bug === "B11") {
    return [
      sc(bug, {
        seed: 1,
        electionBonusUs: [0, 150_000, 150_000],
        tightElection: false,
        faults: [],
        workload: [
          { at: 280_000, client: 0, seq: 1, node: 0, op: "add", key: "c", value: "1" },
          { at: 800_000, client: 1, seq: 1, node: 0, op: "get", key: "c", value: "" },
        ],
        maxTimeUs: 1_200_000,
      }),
    ];
  }
  return [];
}

/** A harsh but legal random scenario. Draws come from keyed(seed), not Math.random. */
export function randomScenario(bug: BugId, seed: number): Scenario {
  const faults: Fault[] = [];
  const nFaults = keyed(seed, 3, 0, 0, 0) % 3;
  for (let i = 0; i < nFaults; i++) {
    const roll = keyed(seed, 3, 1, i, 0) % 3;
    const node = keyed(seed, 3, 2, i, 0) % 3;
    const at = 180_000 + (keyed(seed, 3, 3, i, 0) % 700_000);
    const dur = 40_000 + (keyed(seed, 3, 4, i, 0) % 280_000);
    if (roll === 0) faults.push({ kind: "crash", node, at, until: at + dur });
    else if (roll === 1) faults.push({ kind: "isolate", node, at, until: at + dur });
    else faults.push({ kind: "mute", node, at, until: at + dur });
  }
  const ops = 3 + (keyed(seed, 3, 5, 0, 0) % 3);
  const workload: WorkItem[] = [];
  for (let i = 0; i < ops; i++) {
    const at = 240_000 + i * 160_000;
    const node = keyed(seed, 3, 6, i, 0) % 3;
    const roll = keyed(seed, 3, 7, i, 0) % 5;
    const key = roll === 4 ? "c" : (keyed(seed, 3, 8, i, 0) % 2 === 0 ? "a" : "b");
    let op: WorkItem["op"] = "get";
    let value = "";
    if (key === "c") {
      op = roll % 2 === 0 ? "add" : "get";
      value = "1";
    } else if (roll % 2 === 0) {
      op = "put";
      value = String(keyed(seed, 3, 9, i, 0) % 40);
    }
    workload.push({ at, client: i % 3, seq: i + 1, node, op, key, value });
  }
  return {
    seed,
    bug,
    nodes: 3,
    electionBonusUs: [0, 0, 0],
    tightElection: false,
    faults,
    workload,
    maxTimeUs: 1_400_000,
  };
}

/** Portfolio for a hunt or a soundness spot-check. Stops being interesting after the first hit. */
export function candidates(bug: BugId): Scenario[] {
  if (bug === "correct") {
    const out: Scenario[] = [];
    const probes: BugId[] = ["B01", "B02", "B03", "B04", "B05", "B06", "B07", "B11"];
    for (let i = 0; i < probes.length; i++) {
      const id = probes[i];
      if (!id) continue;
      const aimed = targeted(id);
      for (let j = 0; j < aimed.length && j < 2; j++) {
        const s = aimed[j];
        if (s) out.push({ ...s, bug: "correct" });
      }
    }
    for (let seed = 1; seed <= 24; seed++) out.push(randomScenario("correct", seed));
    return out;
  }
  const out = targeted(bug);
  for (let seed = 1; seed <= 12; seed++) out.push(randomScenario(bug, seed));
  return out;
}

function fails(s: Scenario): boolean {
  return runScenario(s, "fast").violation !== null;
}

function ddmin(faults: Fault[], test: (f: Fault[]) => boolean, budget: { left: number }): Fault[] {
  let cur = faults;
  if (cur.length < 2) return cur;
  let gran = 2;
  while (cur.length >= 2 && budget.left > 0) {
    const parts = split(cur, gran);
    let reduced = false;
    for (let i = 0; i < parts.length && budget.left > 0; i++) {
      const part = parts[i];
      if (!part) continue;
      budget.left -= 1;
      if (test(part)) {
        cur = part;
        gran = 2;
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    for (let i = 0; i < parts.length && budget.left > 0; i++) {
      const part = parts[i];
      if (!part) continue;
      const comp = without(cur, part);
      budget.left -= 1;
      if (test(comp)) {
        cur = comp;
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (gran >= cur.length) break;
      gran = Math.min(cur.length, gran * 2);
    }
  }
  return cur;
}

function split(faults: Fault[], gran: number): Fault[][] {
  const out: Fault[][] = [];
  const size = Math.max(1, Math.ceil(faults.length / gran));
  for (let i = 0; i < faults.length; i += size) out.push(faults.slice(i, i + size));
  return out;
}

function without(all: Fault[], drop: Fault[]): Fault[] {
  const out: Fault[] = [];
  for (let i = 0; i < all.length; i++) {
    const f = all[i];
    if (!f) continue;
    let hit = false;
    for (let j = 0; j < drop.length; j++) if (drop[j] === f) hit = true;
    if (!hit) out.push(f);
  }
  return out;
}

/**
 * Shrink faults, then workload, then the time bound.
 * The result still violates. Returns the original scenario if it was already clean.
 */
export function shrinkScenario(scenario: Scenario): { scenario: Scenario; runs: number } {
  const budget = { left: 48 };
  let runs = 0;
  const testFaults = (faults: Fault[], base: Scenario): boolean => {
    if (budget.left <= 0) return false;
    budget.left -= 1;
    runs += 1;
    return fails({ ...base, faults });
  };
  if (!fails(scenario)) return { scenario, runs: 1 };
  runs += 1;
  let faults = scenario.faults;
  if (faults.length > 0) {
    faults = ddmin(faults, (f) => testFaults(f, scenario), budget);
    let changed = true;
    while (changed && budget.left > 0) {
      changed = false;
      for (let i = 0; i < faults.length; i++) {
        const next = faults.slice(0, i).concat(faults.slice(i + 1));
        if (testFaults(next, scenario)) {
          faults = next;
          changed = true;
          break;
        }
      }
    }
  }
  let workload = scenario.workload.slice();
  let changed = true;
  while (changed && budget.left > 0) {
    changed = false;
    for (let i = workload.length - 1; i >= 0; i--) {
      const next = workload.slice(0, i).concat(workload.slice(i + 1));
      budget.left -= 1;
      runs += 1;
      if (fails({ ...scenario, faults, workload: next })) {
        workload = next;
        changed = true;
        break;
      }
    }
  }
  let lo = 0;
  let hi = scenario.maxTimeUs;
  let best = hi;
  while (hi - lo > 25_000 && budget.left > 0) {
    const mid = lo + Math.floor((hi - lo) / 2);
    budget.left -= 1;
    runs += 1;
    if (fails({ ...scenario, faults, workload, maxTimeUs: mid })) {
      best = mid;
      hi = mid;
    } else lo = mid;
  }
  return {
    scenario: { ...scenario, faults, workload, maxTimeUs: best },
    runs,
  };
}

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** URL-safe encoding of a scenario. ASCII JSON only. */
export function encodeReplay(scenario: Scenario): string {
  const json = JSON.stringify(scenario);
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

/** Inverse of encodeReplay. Returns null when the payload is not a scenario. */
export function decodeReplay(text: string): Scenario | null {
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
    const raw: unknown = JSON.parse(json);
    if (!isScenario(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

function isScenario(v: unknown): v is Scenario {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.seed === "number" &&
    typeof o.bug === "string" &&
    typeof o.nodes === "number" &&
    Array.isArray(o.electionBonusUs) &&
    typeof o.tightElection === "boolean" &&
    Array.isArray(o.faults) &&
    Array.isArray(o.workload) &&
    typeof o.maxTimeUs === "number"
  );
}
