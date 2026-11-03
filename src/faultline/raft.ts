/** Raft state machine. Bug switches are explicit and local. */

import { keyed, popcount } from "./keyed.ts";
import type { Body, BugId, Cmd, LogEntry, Node, Scenario } from "./types.ts";
import { fold, readKey } from "./check.ts";

/** Side effects the world applies. Timers are already stored on the node. */
export type Action =
  | { t: "send"; to: number; body: Body }
  | { t: "reply"; client: number; seq: number; ok: boolean; result: string; hint: number }
  | { t: "election"; due: number }
  | { t: "heartbeat"; due: number };

const HB = 50_000;
const ELECT_BASE = 120_000;
const ELECT_SPAN = 40_000;
const ELECT_TIGHT = 8_000;

/** Majority, unless B03 treats the leader alone as enough. */
export function quorum(n: number, bug: BugId): number {
  if (bug === "B03") return 1;
  return Math.floor(n / 2) + 1;
}

/** Fresh follower with a sentinel log entry at index 0. */
export function makeNode(id: number, n: number): Node {
  const next: number[] = [];
  const match: number[] = [];
  for (let i = 0; i < n; i++) {
    next.push(1);
    match.push(0);
  }
  return {
    id,
    alive: true,
    epoch: 0,
    role: "follower",
    term: 0,
    votedFor: -1,
    leaderHint: -1,
    log: [{ term: 0, cmd: null }],
    commit: 0,
    applied: 0,
    next,
    match,
    grantors: 0,
    kv: {},
    seen: {},
    pending: [],
    reads: [],
    ticket: 0,
    electionDue: 0,
    heartbeatDue: 0,
    electAttempt: 0,
  };
}

/** B05: restart with an empty disk. Keeps id, epoch, and liveness. */
export function wipeNode(node: Node): void {
  const fresh = makeNode(node.id, node.next.length);
  fresh.alive = node.alive;
  fresh.epoch = node.epoch;
  node.alive = fresh.alive;
  node.epoch = fresh.epoch;
  node.role = fresh.role;
  node.term = fresh.term;
  node.votedFor = fresh.votedFor;
  node.leaderHint = fresh.leaderHint;
  node.log = fresh.log;
  node.commit = fresh.commit;
  node.applied = fresh.applied;
  node.next = fresh.next;
  node.match = fresh.match;
  node.grantors = fresh.grantors;
  node.kv = fresh.kv;
  node.seen = fresh.seen;
  node.pending = fresh.pending;
  node.reads = fresh.reads;
  node.ticket = fresh.ticket;
  node.electionDue = fresh.electionDue;
  node.heartbeatDue = fresh.heartbeatDue;
  node.electAttempt = fresh.electAttempt;
}

function electionDelay(node: Node, scenario: Scenario): number {
  const span = scenario.tightElection ? ELECT_TIGHT : ELECT_SPAN;
  const j = keyed(scenario.seed, 2, node.id, node.term, node.electAttempt) % span;
  const bonus = scenario.electionBonusUs[node.id] ?? 0;
  return ELECT_BASE + j + bonus;
}

function armElection(node: Node, now: number, scenario: Scenario): Action[] {
  node.electAttempt += 1;
  const due = now + electionDelay(node, scenario);
  node.electionDue = due;
  return [{ t: "election", due }];
}

function armHeartbeat(node: Node, now: number): Action[] {
  node.heartbeatDue = now + HB;
  return [{ t: "heartbeat", due: node.heartbeatDue }];
}

function becomeFollower(node: Node, term: number, now: number, scenario: Scenario): Action[] {
  if (term > node.term) {
    node.term = term;
    node.votedFor = -1;
  }
  node.role = "follower";
  node.grantors = 0;
  return armElection(node, now, scenario);
}

function cmdEq(a: LogEntry, b: LogEntry): boolean {
  if (!a.cmd && !b.cmd) return true;
  if (!a.cmd || !b.cmd) return false;
  return (
    a.cmd.op === b.cmd.op &&
    a.cmd.key === b.cmd.key &&
    a.cmd.value === b.cmd.value &&
    a.cmd.client === b.cmd.client &&
    a.cmd.seq === b.cmd.seq
  );
}

function cloneEntry(e: LogEntry): LogEntry {
  if (!e.cmd) return { term: e.term, cmd: null };
  const c = e.cmd;
  return {
    term: e.term,
    cmd: { op: c.op, key: c.key, value: c.value, client: c.client, seq: c.seq },
  };
}

function advance(node: Node, bug: BugId): Action[] {
  if (node.commit > node.applied) node.applied = node.commit;
  if (node.applied >= node.log.length) node.applied = node.log.length - 1;
  node.kv = fold(node.log, node.applied, bug);
  return fulfill(node);
}

function fulfill(node: Node): Action[] {
  const actions: Action[] = [];
  const keep = [];
  for (let i = 0; i < node.pending.length; i++) {
    const p = node.pending[i];
    if (!p || p.index > node.applied || p.index >= node.log.length) {
      if (p) keep.push(p);
      continue;
    }
    const cmd = node.log[p.index]?.cmd;
    if (!cmd) {
      keep.push(p);
      continue;
    }
    const id = cmd.client + ":" + cmd.seq;
    const result = cmd.op === "add" ? (node.kv[cmd.key] ?? "0") : "ok";
    node.seen[id] = result;
    actions.push({ t: "reply", client: cmd.client, seq: cmd.seq, ok: true, result, hint: node.id });
  }
  node.pending = keep;
  return actions;
}

function tryCommit(node: Node, bug: BugId): Action[] {
  if (node.role !== "leader") return [];
  const q = quorum(node.next.length, bug);
  for (let i = node.log.length - 1; i > node.commit; i--) {
    const e = node.log[i];
    if (!e || e.term !== node.term) continue;
    let count = 0;
    for (let p = 0; p < node.match.length; p++) {
      if ((node.match[p] ?? 0) >= i) count += 1;
    }
    if (count >= q) {
      node.commit = i;
      return advance(node, bug);
    }
  }
  return [];
}

function sendAppend(node: Node, to: number): Action | null {
  if (to === node.id) return null;
  let next = node.next[to] ?? 1;
  if (next < 1) next = 1;
  if (next > node.log.length) next = node.log.length;
  const prevIndex = next - 1;
  const prev = node.log[prevIndex];
  if (!prev) return null;
  const entries: LogEntry[] = [];
  for (let i = next; i < node.log.length; i++) {
    const e = node.log[i];
    if (e) entries.push(cloneEntry(e));
  }
  return {
    t: "send",
    to,
    body: {
      t: "ae",
      term: node.term,
      leader: node.id,
      prevIndex,
      prevTerm: prev.term,
      entries,
      leaderCommit: node.commit,
    },
  };
}

function replicate(node: Node): Action[] {
  const actions: Action[] = [];
  for (let p = 0; p < node.next.length; p++) {
    if (p === node.id) continue;
    const a = sendAppend(node, p);
    if (a) actions.push(a);
  }
  return actions;
}

/** B01 lies about replication by marking every peer caught up. */
function noteMatch(node: Node, index: number, bug: BugId): void {
  node.match[node.id] = index;
  if (bug === "B01") {
    for (let p = 0; p < node.match.length; p++) node.match[p] = index;
  }
}

function becomeLeader(node: Node, now: number, scenario: Scenario): Action[] {
  node.role = "leader";
  node.leaderHint = node.id;
  node.grantors = 0;
  node.log.push({ term: node.term, cmd: null });
  const last = node.log.length - 1;
  for (let p = 0; p < node.next.length; p++) {
    node.next[p] = last;
    node.match[p] = 0;
  }
  noteMatch(node, last, scenario.bug);
  const actions: Action[] = [...armHeartbeat(node, now)];
  actions.push(...tryCommit(node, scenario.bug));
  actions.push(...replicate(node));
  return actions;
}

function logUpToDate(node: Node, lastIndex: number, lastTerm: number): boolean {
  const last = node.log[node.log.length - 1];
  const myTerm = last ? last.term : 0;
  const myIndex = node.log.length - 1;
  if (lastTerm !== myTerm) return lastTerm > myTerm;
  return lastIndex >= myIndex;
}

/** Arm the first election timeout at t=0. Does not start a campaign. */
export function boot(node: Node, scenario: Scenario): Action[] {
  return armElection(node, 0, scenario);
}

/** Arm an election timeout at an arbitrary virtual time (restart). */
export function wake(node: Node, now: number, scenario: Scenario): Action[] {
  return armElection(node, now, scenario);
}

/** Election timer fired. */
export function onElection(node: Node, now: number, scenario: Scenario): Action[] {
  if (!node.alive || node.role === "leader") return [];
  node.term += 1;
  node.role = "candidate";
  node.votedFor = node.id;
  node.leaderHint = -1;
  node.grantors = 1 << node.id;
  const actions = armElection(node, now, scenario);
  const last = node.log[node.log.length - 1];
  const lastTerm = last ? last.term : 0;
  for (let p = 0; p < node.next.length; p++) {
    if (p === node.id) continue;
    actions.push({
      t: "send",
      to: p,
      body: {
        t: "rv",
        term: node.term,
        candidate: node.id,
        lastIndex: node.log.length - 1,
        lastTerm,
      },
    });
  }
  return actions;
}

/** Leader heartbeat. */
export function onHeartbeat(node: Node, now: number, scenario: Scenario): Action[] {
  if (!node.alive || node.role !== "leader") return [];
  const actions = armHeartbeat(node, now);
  actions.push(...replicate(node));
  return actions;
}

function onRequestVote(node: Node, body: Extract<Body, { t: "rv" }>, now: number, scenario: Scenario): Action[] {
  const actions: Action[] = [];
  if (body.term > node.term) actions.push(...becomeFollower(node, body.term, now, scenario));
  let granted = false;
  if (body.term === node.term) {
    const up = scenario.bug === "B02" ? true : logUpToDate(node, body.lastIndex, body.lastTerm);
    const open = node.votedFor === -1 || node.votedFor === body.candidate;
    const can = open || scenario.bug === "B04";
    if (up && can) {
      granted = true;
      node.votedFor = body.candidate;
      actions.push(...armElection(node, now, scenario));
    }
  }
  actions.push({
    t: "send",
    to: body.candidate,
    body: { t: "rv_r", term: node.term, granted, from: node.id },
  });
  return actions;
}

function onVoteReply(node: Node, body: Extract<Body, { t: "rv_r" }>, now: number, scenario: Scenario): Action[] {
  if (body.term > node.term) return becomeFollower(node, body.term, now, scenario);
  if (node.role !== "candidate" || body.term !== node.term || !body.granted) return [];
  node.grantors |= 1 << body.from;
  if (popcount(node.grantors) >= quorum(node.next.length, scenario.bug)) {
    return becomeLeader(node, now, scenario);
  }
  return [];
}

function rejectAppend(node: Node, leader: number): Action {
  return {
    t: "send",
    to: leader,
    body: { t: "ae_r", term: node.term, success: false, match: node.log.length - 1, from: node.id },
  };
}

function onAppend(node: Node, body: Extract<Body, { t: "ae" }>, now: number, scenario: Scenario): Action[] {
  const actions: Action[] = [];
  if (body.term > node.term) actions.push(...becomeFollower(node, body.term, now, scenario));
  if (body.term < node.term) {
    actions.push(rejectAppend(node, body.leader));
    return actions;
  }
  if (node.role !== "follower") {
    node.role = "follower";
    node.grantors = 0;
  }
  node.leaderHint = body.leader;
  actions.push(...armElection(node, now, scenario));
  const prev = body.prevIndex >= 0 ? node.log[body.prevIndex] : undefined;
  if (!prev || prev.term !== body.prevTerm) {
    actions.push(rejectAppend(node, body.leader));
    return actions;
  }
  // Raft paper: delete only at a real conflict. A shorter matching prefix must
  // not chop a longer suffix — stale heartbeats arrive out of order.
  let conflictAt = -1;
  for (let e = 0; e < body.entries.length; e++) {
    const entry = body.entries[e];
    if (!entry) continue;
    const index = body.prevIndex + 1 + e;
    const existing = node.log[index];
    if (!existing) {
      node.log.push(cloneEntry(entry));
      continue;
    }
    if (existing.term !== entry.term || !cmdEq(existing, entry)) {
      conflictAt = index;
      break;
    }
  }
  if (conflictAt >= 0) {
    const kept: LogEntry[] = [];
    for (let i = 0; i < conflictAt; i++) {
      const old = node.log[i];
      if (old) kept.push(cloneEntry(old));
    }
    for (let e = conflictAt - body.prevIndex - 1; e < body.entries.length; e++) {
      const entry = body.entries[e];
      if (entry) kept.push(cloneEntry(entry));
    }
    for (let i = 1; i <= node.commit; i++) {
      const oldE = node.log[i];
      const newE = kept[i];
      if (!oldE || !newE || oldE.term !== newE.term || !cmdEq(oldE, newE)) {
        actions.push(rejectAppend(node, body.leader));
        return actions;
      }
    }
    node.log = kept;
  }
  const matched = body.prevIndex + body.entries.length;
  if (body.leaderCommit > node.commit) {
    const cap = Math.min(body.leaderCommit, matched);
    if (cap > node.commit && cap < node.log.length) {
      node.commit = cap;
      actions.push(...advance(node, scenario.bug));
    }
  }
  actions.push({
    t: "send",
    to: body.leader,
    body: { t: "ae_r", term: node.term, success: true, match: matched, from: node.id },
  });
  return actions;
}

function onAppendReply(node: Node, body: Extract<Body, { t: "ae_r" }>, now: number, scenario: Scenario): Action[] {
  if (body.term > node.term) return becomeFollower(node, body.term, now, scenario);
  if (node.role !== "leader" || body.term !== node.term) return [];
  if (!body.success) {
    const n = node.next[body.from] ?? 1;
    const dec = Math.max(1, n - 1);
    node.next[body.from] = dec;
    if (dec === n) return [];
    const again = sendAppend(node, body.from);
    return again ? [again] : [];
  }
  if (body.match > (node.match[body.from] ?? 0)) node.match[body.from] = body.match;
  node.next[body.from] = (node.match[body.from] ?? 0) + 1;
  return tryCommit(node, scenario.bug);
}

function finishRead(node: Node, ticket: number): Action[] {
  const actions: Action[] = [];
  const keep = [];
  const need = quorum(node.next.length, "correct");
  for (let i = 0; i < node.reads.length; i++) {
    const r = node.reads[i];
    if (!r) continue;
    if (r.ticket !== ticket || popcount(r.bits) < need) {
      keep.push(r);
      continue;
    }
    actions.push({
      t: "reply",
      client: r.client,
      seq: r.seq,
      ok: true,
      result: readKey(node.kv, r.key),
      hint: node.id,
    });
  }
  node.reads = keep;
  return actions;
}

function onReadQ(node: Node, body: Extract<Body, { t: "rq" }>, now: number, scenario: Scenario): Action[] {
  if (body.term > node.term) {
    const actions = becomeFollower(node, body.term, now, scenario);
    actions.push({ t: "send", to: body.leader, body: { t: "rq_r", term: node.term, from: node.id, ticket: body.ticket } });
    return actions;
  }
  if (body.term < node.term || node.id === body.leader) return [];
  if (node.role !== "follower") {
    node.role = "follower";
    node.grantors = 0;
  }
  node.leaderHint = body.leader;
  const actions = armElection(node, now, scenario);
  actions.push({ t: "send", to: body.leader, body: { t: "rq_r", term: node.term, from: node.id, ticket: body.ticket } });
  return actions;
}

function onReadReply(node: Node, body: Extract<Body, { t: "rq_r" }>, now: number, scenario: Scenario): Action[] {
  if (body.term > node.term) return becomeFollower(node, body.term, now, scenario);
  if (node.role !== "leader" || body.term !== node.term) return [];
  for (let i = 0; i < node.reads.length; i++) {
    const r = node.reads[i];
    if (r && r.ticket === body.ticket) r.bits |= 1 << body.from;
  }
  return finishRead(node, body.ticket);
}

/** Inbound network message. */
export function onBody(node: Node, body: Body, now: number, scenario: Scenario): Action[] {
  if (!node.alive) return [];
  if (body.t === "rv") return onRequestVote(node, body, now, scenario);
  if (body.t === "rv_r") return onVoteReply(node, body, now, scenario);
  if (body.t === "ae") return onAppend(node, body, now, scenario);
  if (body.t === "ae_r") return onAppendReply(node, body, now, scenario);
  if (body.t === "rq") return onReadQ(node, body, now, scenario);
  return onReadReply(node, body, now, scenario);
}

/** Client request delivered straight to this process (colocated client). */
export function onClient(
  node: Node,
  op: "put" | "get" | "add",
  key: string,
  value: string,
  client: number,
  seq: number,
  scenario: Scenario,
): Action[] {
  if (!node.alive) return [{ t: "reply", client, seq, ok: false, result: "", hint: -1 }];
  if (node.role !== "leader") {
    return [{ t: "reply", client, seq, ok: false, result: "", hint: node.leaderHint }];
  }
  if (op === "get") {
    if (scenario.bug === "B06") {
      return [{ t: "reply", client, seq, ok: true, result: readKey(node.kv, key), hint: node.id }];
    }
    node.ticket += 1;
    const ticket = node.ticket;
    node.reads.push({ client, seq, key, ticket, bits: 1 << node.id });
    const actions: Action[] = [];
    for (let p = 0; p < node.next.length; p++) {
      if (p === node.id) continue;
      actions.push({ t: "send", to: p, body: { t: "rq", term: node.term, leader: node.id, ticket } });
    }
    actions.push(...finishRead(node, ticket));
    return actions;
  }
  const id = client + ":" + seq;
  if (scenario.bug !== "B11" && node.seen[id] !== undefined) {
    return [{ t: "reply", client, seq, ok: true, result: node.seen[id] ?? "ok", hint: node.id }];
  }
  if (scenario.bug !== "B11") {
    for (let i = 0; i < node.pending.length; i++) {
      const p = node.pending[i];
      if (p && p.client === client && p.seq === seq) return [];
    }
  }
  const cmd: Cmd = { op, key, value, client, seq };
  node.log.push({ term: node.term, cmd });
  const index = node.log.length - 1;
  noteMatch(node, index, scenario.bug);
  node.pending.push({ client, seq, index });
  const actions = tryCommit(node, scenario.bug);
  actions.push(...replicate(node));
  return actions;
}
