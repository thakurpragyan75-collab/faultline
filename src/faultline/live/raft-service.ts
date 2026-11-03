/**
 * Raft service behind the connector.
 * The process loop lives here. Faultline's runner only receives history and status pages.
 */

import { keyed } from "../keyed.ts";
import { boot, makeNode, onBody, onClient, onElection, onHeartbeat, wake, wipeNode } from "../raft.ts";
import type { Action } from "../raft.ts";
import type { Body, Fault, Hist, Node, Scenario, WorkItem } from "../types.ts";
import type { Experiment, Observation, Status, SystemAdapter } from "./types.ts";
import { statusAlarm } from "./verify.ts";

type EvKind = "election" | "heartbeat" | "deliver" | "crash-on" | "crash-off" | "client";

type Ev = {
  time: number;
  seq: number;
  kind: EvKind;
  node: number;
  due: number;
  epoch: number;
  from: number;
  to: number;
  body: Body | null;
  work: number;
  token: number;
};

type Job = { start: number; done: boolean; attempts: number; node: number; token: number };
type Heap = { a: Ev[]; n: number };

const LAT_MIN = 8_000;
const LAT_SPAN = 18_000;
const WRITE_RETRY = 15_000;
const PATIENCE = 50_000;
const REDIRECT = 2_000;

function heapNew(): Heap {
  return { a: [], n: 0 };
}

function before(x: Ev, y: Ev): boolean {
  if (x.time !== y.time) return x.time < y.time;
  return x.seq < y.seq;
}

function heapPush(h: Heap, e: Ev): void {
  const a = h.a;
  let i = h.n;
  a[i] = e;
  h.n = i + 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    const parent = a[p];
    const cur = a[i];
    if (!parent || !cur || !before(cur, parent)) break;
    a[i] = parent;
    a[p] = cur;
    i = p;
  }
}

function heapPop(h: Heap): Ev | null {
  if (h.n === 0) return null;
  const a = h.a;
  const top = a[0];
  if (!top) return null;
  h.n -= 1;
  const last = a[h.n];
  if (h.n === 0 || !last) return top;
  a[0] = last;
  let i = 0;
  for (;;) {
    const l = i * 2 + 1;
    const r = l + 1;
    let m = i;
    const left = l < h.n ? a[l] : undefined;
    const right = r < h.n ? a[r] : undefined;
    const at = a[m];
    if (left && at && before(left, at)) m = l;
    const best = a[m];
    if (right && best && before(right, best)) m = r;
    if (m === i) break;
    const tmp = a[i];
    a[i] = a[m] as Ev;
    a[m] = tmp as Ev;
    i = m;
  }
  return top;
}

function blank(time: number, kind: EvKind): Ev {
  return { time, seq: 0, kind, node: -1, due: 0, epoch: 0, from: -1, to: -1, body: null, work: -1, token: 0 };
}

function ms(us: number): string {
  return Math.floor(us / 1000) + "ms";
}

function entryLabel(node: Node, index: number): string {
  const entry = node.log[index];
  if (!entry || !entry.cmd) return "noop";
  if (entry.cmd.op === "put") return "put " + entry.cmd.key + "=" + entry.cmd.value;
  return "add " + entry.cmd.key + "+" + entry.cmd.value;
}

function scrape(nodes: Node[]): Status[] {
  const out: Status[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;
    const entries: string[] = [];
    for (let index = 1; index <= node.commit; index++) entries.push(entryLabel(node, index));
    out.push({
      id: node.id,
      role: node.role,
      term: node.term,
      alive: node.alive,
      commit: node.commit,
      entries,
    });
  }
  return out;
}

function asScenario(experiment: Experiment): Scenario {
  return {
    seed: experiment.seed,
    bug: experiment.bug,
    nodes: experiment.nodes,
    electionBonusUs: experiment.electionBonusUs,
    tightElection: experiment.tightElection,
    faults: experiment.faults,
    workload: experiment.calls,
    maxTimeUs: experiment.maxTimeUs,
  };
}

/** Host the Raft processes and return only what a connector can observe. */
export function executeRaft(experiment: Experiment): Observation {
  const scenario = asScenario(experiment);
  const n = scenario.nodes;
  const nodes: Node[] = [];
  for (let i = 0; i < n; i++) nodes.push(makeNode(i, n));
  const heap = heapNew();
  let seqn = 1;
  const push = (e: Ev): void => {
    e.seq = seqn;
    seqn += 1;
    heapPush(heap, e);
  };
  const link: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) row.push(0);
    link.push(row);
  }
  const history: Hist[] = [];
  const notes: string[] = ["connected raft-service · " + n + " processes · build " + scenario.bug];
  const samples: Status[][] = [];
  const jobs: Job[] = [];
  let lastSig = "";

  const note = (line: string): void => {
    if (notes.length < 48) notes.push(line);
  };

  const remember = (): void => {
    const sample = scrape(nodes);
    let sig = "";
    for (let i = 0; i < sample.length; i++) {
      const node = sample[i];
      if (!node) continue;
      sig += node.id + node.role[0] + node.term + ":" + node.commit + (node.alive ? "1" : "0") + "|";
    }
    if (sig === lastSig) return;
    lastSig = sig;
    const alarm = statusAlarm(sample) !== null;
    if (alarm || samples.length < 24) samples.push(sample);
  };

  const scheduleClient = (work: number, time: number): void => {
    const job = jobs[work];
    if (!job) return;
    job.token += 1;
    const ev = blank(time, "client");
    ev.work = work;
    ev.token = job.token;
    push(ev);
  };

  const complete = (client: number, seq: number, result: string, now: number): void => {
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const item = scenario.workload[i];
      if (!job || !item || job.done) continue;
      if (item.client !== client || item.seq !== seq) continue;
      job.done = true;
      history.push({
        client,
        seq,
        op: item.op,
        key: item.key,
        value: item.value,
        result,
        start: job.start < 0 ? now : job.start,
        end: now,
      });
      const what =
        item.op === "put"
          ? "put " + item.key + "=" + item.value
          : item.op === "add"
            ? "add " + item.key + "+" + item.value
            : "get " + item.key;
      note("c" + client + " " + what + " → " + (result === "" ? "empty" : result) + " at " + ms(now));
    }
  };

  const faultOn = (time: number, pred: (fault: Fault) => boolean): boolean => {
    for (let i = 0; i < scenario.faults.length; i++) {
      const fault = scenario.faults[i];
      if (!fault || time < fault.at || time >= fault.until) continue;
      if (pred(fault)) return true;
    }
    return false;
  };

  const muted = (id: number, time: number): boolean =>
    faultOn(time, (fault) => fault.kind === "mute" && fault.node === id);

  const blocked = (a: number, b: number, time: number): boolean =>
    faultOn(
      time,
      (fault) =>
        (fault.kind === "isolate" && (fault.node === a || fault.node === b)) ||
        (fault.kind === "cut" && ((fault.a === a && fault.b === b) || (fault.a === b && fault.b === a))),
    );

  const latency = (a: number, b: number): number => {
    const row = link[a];
    const prev = row?.[b] ?? 0;
    const count = prev + 1;
    if (row) row[b] = count;
    return LAT_MIN + (keyed(scenario.seed, 1, a, b, count) % LAT_SPAN);
  };

  const applyActions = (self: number, actions: Action[], now: number): { rejected: boolean; hint: number } => {
    let rejected = false;
    let hint = -1;
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (!action) continue;
      if (action.t === "election") {
        const ev = blank(action.due, "election");
        ev.node = self;
        ev.due = action.due;
        push(ev);
      } else if (action.t === "heartbeat") {
        const ev = blank(action.due, "heartbeat");
        ev.node = self;
        ev.due = action.due;
        push(ev);
      } else if (action.t === "reply") {
        if (action.ok) complete(action.client, action.seq, action.result, now);
        else {
          rejected = true;
          hint = action.hint;
        }
      } else if (action.t === "send") {
        const sender = nodes[self];
        if (!sender || !sender.alive || muted(self, now)) continue;
        const ev = blank(now + latency(self, action.to), "deliver");
        ev.from = self;
        ev.to = action.to;
        ev.node = action.to;
        ev.body = action.body;
        ev.epoch = sender.epoch;
        push(ev);
      }
    }
    return { rejected, hint };
  };

  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if (!node) continue;
    applyActions(i, boot(node, scenario), 0);
  }
  for (let i = 0; i < scenario.faults.length; i++) {
    const fault = scenario.faults[i];
    if (!fault || fault.kind !== "crash") continue;
    const on = blank(fault.at, "crash-on");
    on.node = fault.node;
    push(on);
    const off = blank(fault.until, "crash-off");
    off.node = fault.node;
    push(off);
  }
  for (let i = 0; i < scenario.workload.length; i++) {
    const item: WorkItem | undefined = scenario.workload[i];
    if (!item) continue;
    jobs.push({ start: -1, done: false, attempts: 0, node: item.node, token: 0 });
    scheduleClient(i, item.at);
  }

  let steps = 0;
  let now = 0;
  while (heap.n > 0 && steps < 14_000) {
    const ev = heapPop(heap);
    if (!ev || ev.time > scenario.maxTimeUs) break;
    now = ev.time;
    steps += 1;
    if (ev.kind === "election") {
      const node = nodes[ev.node];
      if (node && node.alive && node.electionDue === ev.due) applyActions(node.id, onElection(node, now, scenario), now);
    } else if (ev.kind === "heartbeat") {
      const node = nodes[ev.node];
      if (node && node.alive && node.role === "leader" && node.heartbeatDue === ev.due) {
        applyActions(node.id, onHeartbeat(node, now, scenario), now);
      }
    } else if (ev.kind === "deliver" && ev.body) {
      const sender = nodes[ev.from];
      const dest = nodes[ev.to];
      if (sender && dest && sender.epoch === ev.epoch && dest.alive && !blocked(ev.from, ev.to, now)) {
        applyActions(dest.id, onBody(dest, ev.body, now, scenario), now);
      }
    } else if (ev.kind === "crash-on") {
      const node = nodes[ev.node];
      if (node) {
        node.alive = false;
        node.epoch += 1;
        note("power cut n" + node.id + " at " + ms(now));
      }
    } else if (ev.kind === "crash-off") {
      const node = nodes[ev.node];
      if (node) {
        node.alive = true;
        if (scenario.bug === "B05") wipeNode(node);
        applyActions(node.id, wake(node, now, scenario), now);
        note((scenario.bug === "B05" ? "n" + node.id + " restarts blank" : "n" + node.id + " restarts") + " at " + ms(now));
      }
    } else if (ev.kind === "client") {
      const job = jobs[ev.work];
      const item = scenario.workload[ev.work];
      if (job && item && !job.done && job.token === ev.token) {
        if (job.start < 0) job.start = now;
        const node = nodes[job.node];
        if (node) {
          const res = applyActions(
            node.id,
            onClient(node, item.op, item.key, item.value, item.client, item.seq, scenario),
            now,
          );
          if (!job.done && res.rejected) {
            if (res.hint >= 0 && res.hint < n && res.hint !== job.node) job.node = res.hint;
            else job.node = (job.node + 1) % n;
            job.attempts += 1;
            if (job.attempts <= 8) scheduleClient(ev.work, now + REDIRECT);
          } else if (!job.done && (item.op === "put" || item.op === "add") && job.attempts === 0) {
            job.attempts = 1;
            scheduleClient(ev.work, now + WRITE_RETRY);
          } else if (!job.done) {
            job.attempts += 1;
            if (job.attempts <= 6) scheduleClient(ev.work, now + PATIENCE);
          }
        }
      }
    }
    remember();
  }
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const item = scenario.workload[i];
    if (!job || !item || job.done || job.start < 0) continue;
    history.push({
      client: item.client,
      seq: item.seq,
      op: item.op,
      key: item.key,
      value: item.value,
      result: "timeout",
      start: job.start,
      end: now,
    });
    note("c" + item.client + " " + item.op + " " + item.key + " → timeout at " + ms(now));
  }
  remember();
  return { history, notes, samples, steps };
}

export const raftAdapter: SystemAdapter = {
  id: "raft-service",
  label: "Raft service",
  execute: executeRaft,
};
