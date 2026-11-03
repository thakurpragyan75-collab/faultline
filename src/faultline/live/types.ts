/** Types for the execution layer. Plain JSON. The runner never sees process internals. */

import type { BugId, Fault, Hist, WorkItem } from "../types.ts";

export type TargetId = "raft-service" | "register-service" | "external-kv";

/** One replayable run against a connected service. */
export type Experiment = {
  seed: number;
  target: TargetId;
  bug: BugId;
  nodes: number;
  electionBonusUs: number[];
  tightElection: boolean;
  faults: Fault[];
  calls: WorkItem[];
  maxTimeUs: number;
};

/** What an operator can scrape from one process. */
export type Status = {
  id: number;
  role: string;
  term: number;
  alive: boolean;
  commit: number;
  entries: string[];
};

/** Client history plus the status pages the connector actually returned. */
export type Observation = {
  history: Hist[];
  notes: string[];
  samples: Status[][];
  steps: number;
};

export type LiveReport = {
  violation: import("../types.ts").Violation | null;
  history: Hist[];
  notes: string[];
  hash: number;
  events: number;
  runs: number;
};

export interface SystemAdapter {
  id: TargetId;
  label: string;
  execute(experiment: Experiment): Observation;
}
