/** Shared scenario, trace, and violation types. Plain JSON data only. */

export type BugId =
  | "correct"
  | "B01"
  | "B02"
  | "B03"
  | "B04"
  | "B05"
  | "B06"
  | "B07"
  | "B11";

export type Role = "follower" | "candidate" | "leader";

export type Cmd = {
  op: "put" | "add";
  key: string;
  value: string;
  client: number;
  seq: number;
};

export type LogEntry = {
  term: number;
  cmd: Cmd | null;
};

export type Fault =
  | { kind: "crash"; node: number; at: number; until: number }
  | { kind: "isolate"; node: number; at: number; until: number }
  | { kind: "cut"; a: number; b: number; at: number; until: number }
  | { kind: "mute"; node: number; at: number; until: number };

export type WorkItem = {
  at: number;
  client: number;
  seq: number;
  node: number;
  op: "put" | "get" | "add";
  key: string;
  value: string;
};

/** One fully replayable experiment. */
export type Scenario = {
  seed: number;
  bug: BugId;
  nodes: number;
  electionBonusUs: number[];
  tightElection: boolean;
  faults: Fault[];
  workload: WorkItem[];
  maxTimeUs: number;
};

export type Body =
  | { t: "rv"; term: number; candidate: number; lastIndex: number; lastTerm: number }
  | { t: "rv_r"; term: number; granted: boolean; from: number }
  | {
      t: "ae";
      term: number;
      leader: number;
      prevIndex: number;
      prevTerm: number;
      entries: LogEntry[];
      leaderCommit: number;
    }
  | { t: "ae_r"; term: number; success: boolean; match: number; from: number }
  | { t: "rq"; term: number; leader: number; ticket: number }
  | { t: "rq_r"; term: number; from: number; ticket: number };

export type Hist = {
  client: number;
  seq: number;
  op: "put" | "get" | "add";
  key: string;
  value: string;
  result: string;
  start: number;
  end: number;
};

export type Violation = {
  kind: "dual-leader" | "divergent-commit" | "apply" | "linearizability";
  time: number;
  event: number;
  detail: string;
};

export type Snap = {
  role: Role;
  term: number;
  commit: number;
  alive: boolean;
  memo: string;
};

export type Frame = {
  i: number;
  time: number;
  label: string;
  tone: "msg" | "role" | "fault" | "client" | "bad";
  from: number;
  to: number;
  nodes: Snap[];
};

export type Outcome = {
  violation: Violation | null;
  hash: number;
  events: number;
  frames: Frame[];
  history: Hist[];
};

export type Pending = { client: number; seq: number; index: number };

export type PendingRead = {
  client: number;
  seq: number;
  key: string;
  ticket: number;
  bits: number;
};

/** Raft process state. JSON-serializable. No functions, maps, or sets. */
export type Node = {
  id: number;
  alive: boolean;
  epoch: number;
  role: Role;
  term: number;
  votedFor: number;
  leaderHint: number;
  log: LogEntry[];
  commit: number;
  applied: number;
  next: number[];
  match: number[];
  grantors: number;
  kv: Record<string, string>;
  seen: Record<string, string>;
  pending: Pending[];
  reads: PendingRead[];
  ticket: number;
  electionDue: number;
  heartbeatDue: number;
  electAttempt: number;
};
