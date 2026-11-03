/** Deterministic world: virtual time, keyed latency, faults, and the run loop. */

import { checkLinear, checkSafety } from "./check.ts";
import { keyed, mix, strHash } from "./keyed.ts";
import { boot, makeNode, onBody, onClient, onElection, onHeartbeat, wake, wipeNode } from "./raft.ts";
import type { Action } from "./raft.ts";
import type { Body, Fault, Frame, Hist, Node, Outcome, Role, Scenario, Snap, Violation, WorkItem } from "./types.ts";

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

type Job = {
  start: number;
  done: boolean;
  attempts: number;
  node: number;
  token: number;
};

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
  return {
    time,
    seq: 0,
    kind,
    node: -1,
    due: 0,
    epoch: 0,
    from: -1,
    to: -1,
    body: null,
    work: -1,
    token: 0,
  };
}

function roleCode(role: Role): number {
  if (role === "follower") return 1;
  if (role === "candidate") return 2;
  return 3;
}

function memoOf(node: Node): string {
  const keys = Object.keys(node.kv).sort();
  if (keys.length === 0) return "empty";
  const parts: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k) parts.push(k + "=" + (node.kv[k] ?? ""));
  }
  return parts.join(" ");
}

function snaps(nodes: Node[]): Snap[] {
  const out: Snap[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    out.push({
      role: n.role,
      term: n.term,
      commit: n.commit,
      alive: n.alive,
      memo: memoOf(n),
    });
  }
  return out;
}

function hashState(h: number, time: number, nodes: Node[], history: Hist[]): number {
  let x = mix(h, time >>> 0, nodes.length, history.length, 0);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    x = mix(x, n.id, n.term, n.commit, n.applied);
    x = mix(x, n.alive ? 1 : 0, roleCode(n.role), n.votedFor + 2, n.grantors);
    x = mix(x, n.log.length, n.epoch, n.leaderHint + 2, n.electionDue);
    for (let k = 0; k < n.log.length; k++) {
      const e = n.log[k];
      if (!e) continue;
      const c = e.cmd;
      x = mix(
        x,
        k,
        e.term,
        c ? strHash(c.op + ":" + c.key + ":" + c.value) : 0,
        c ? c.client * 1000 + c.seq : 0,
      );
    }
    const keys = Object.keys(n.kv).sort();
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      if (!key) continue;
      x = mix(x, strHash(key), strHash(n.kv[key] ?? ""), 0, 0);
    }
  }
  for (let i = 0; i < history.length; i++) {
    const hist = history[i];
    if (!hist) continue;
    x = mix(x, hist.start, hist.end, strHash(hist.key + hist.result + hist.value), hist.client * 10 + hist.seq);
  }
  return x >>> 0;
}

function faultActive(f: Fault, time: number): boolean {
  return time >= f.at && time < f.until;
}

/**
 * Run one scenario. Fast and record modes share every state update;
 * record mode only appends frames, so the hash chain matches.
 */
export function runScenario(scenario: Scenario, mode: "fast" | "record"): Outcome {
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
  const frames: Frame[] = [];
  const jobs: Job[] = [];
  let label = "boot";
  let tone: Frame["tone"] = "role";
  let from = -1;
  let to = -1;

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
      label = "c" + client + " " + item.op + " " + item.key + " → " + (result === "" ? "empty" : result);
      tone = "client";
    }
  };

  const muted = (id: number, time: number): boolean => {
    for (let i = 0; i < scenario.faults.length; i++) {
      const f = scenario.faults[i];
      if (!f || !faultActive(f, time)) continue;
      if (f.kind === "mute" && f.node === id) return true;
    }
    return false;
  };

  const blocked = (a: number, b: number, time: number): boolean => {
    for (let i = 0; i < scenario.faults.length; i++) {
      const f = scenario.faults[i];
      if (!f || !faultActive(f, time)) continue;
      if (f.kind === "isolate" && (f.node === a || f.node === b)) return true;
      if (f.kind === "cut" && ((f.a === a && f.b === b) || (f.a === b && f.b === a))) return true;
    }
    return false;
  };

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
        label = "n" + self + " → n" + action.to + " " + action.body.t;
        tone = "msg";
        from = self;
        to = action.to;
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
    const f = scenario.faults[i];
    if (!f || f.kind !== "crash") continue;
    const on = blank(f.at, "crash-on");
    on.node = f.node;
    push(on);
    const off = blank(f.until, "crash-off");
    off.node = f.node;
    push(off);
  }
  for (let i = 0; i < scenario.workload.length; i++) {
    const item: WorkItem | undefined = scenario.workload[i];
    if (!item) continue;
    jobs.push({ start: -1, done: false, attempts: 0, node: item.node, token: 0 });
    scheduleClient(i, item.at);
  }

  let hash = 2166136261;
  let events = 0;
  let now = 0;
  let violation: Violation | null = null;

  while (heap.n > 0 && events < 14_000) {
    const ev = heapPop(heap);
    if (!ev || ev.time > scenario.maxTimeUs) break;
    now = ev.time;
    events += 1;
    label = ev.kind;
    tone = "role";
    from = ev.from;
    to = ev.to;
    if (ev.kind === "election") {
      const node = nodes[ev.node];
      if (node && node.alive && node.electionDue === ev.due) {
        applyActions(node.id, onElection(node, now, scenario), now);
        label = "n" + node.id + " campaigns t" + node.term;
        tone = "role";
      }
    } else if (ev.kind === "heartbeat") {
      const node = nodes[ev.node];
      if (node && node.alive && node.role === "leader" && node.heartbeatDue === ev.due) {
        applyActions(node.id, onHeartbeat(node, now, scenario), now);
        label = "n" + node.id + " heartbeat";
        tone = "msg";
      }
    } else if (ev.kind === "deliver" && ev.body) {
      const sender = nodes[ev.from];
      const dest = nodes[ev.to];
      if (sender && dest && sender.epoch === ev.epoch && dest.alive && !blocked(ev.from, ev.to, now)) {
        applyActions(dest.id, onBody(dest, ev.body, now, scenario), now);
      } else {
        label = "drop n" + ev.from + " → n" + ev.to;
        tone = "fault";
      }
    } else if (ev.kind === "crash-on") {
      const node = nodes[ev.node];
      if (node) {
        node.alive = false;
        node.epoch += 1;
        label = "power cut n" + node.id;
        tone = "fault";
      }
    } else if (ev.kind === "crash-off") {
      const node = nodes[ev.node];
      if (node) {
        node.alive = true;
        if (scenario.bug === "B05") wipeNode(node);
        applyActions(node.id, wake(node, now, scenario), now);
        label = scenario.bug === "B05" ? "n" + node.id + " restarts blank" : "n" + node.id + " restarts";
        tone = "fault";
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
            label = "c" + item.client + " redirected";
            tone = "client";
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
    hash = hashState(hash, now, nodes, history);
    const found = checkSafety(nodes, scenario.bug, now, events);
    if (mode === "record") {
      frames.push({
        i: events,
        time: now,
        label,
        tone: found ? "bad" : tone,
        from,
        to,
        nodes: snaps(nodes),
      });
    }
    if (found) {
      violation = found;
      break;
    }
  }
  if (!violation) violation = checkLinear(history, now, events);
  if (violation && mode === "record" && frames.length > 0) {
    const last = frames[frames.length - 1];
    if (last && last.tone !== "bad") {
      frames.push({
        i: events,
        time: now,
        label: violation.kind,
        tone: "bad",
        from: -1,
        to: -1,
        nodes: snaps(nodes),
      });
    }
  }
  return { violation, hash, events, frames: mode === "record" ? frames : [], history };
}
