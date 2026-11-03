/** Single-process register. Faultline only sees the replies this service returns. */

import { readKey } from "../check.ts";
import { intOf } from "../keyed.ts";
import type { Hist, WorkItem } from "../types.ts";
import type { Experiment, Observation, SystemAdapter } from "./types.ts";

const FLUSH = 40_000;

type Ev =
  | { time: number; kind: "crash-on" | "crash-off" }
  | { time: number; kind: "flush"; gen: number; key: string; value: string }
  | { time: number; kind: "call"; call: WorkItem };

function ms(us: number): string {
  return Math.floor(us / 1000) + "ms";
}

function copy(src: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = Object.keys(src);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key) out[key] = src[key] ?? "";
  }
  return out;
}

function earlier(a: Ev, b: Ev): boolean {
  if (a.time !== b.time) return a.time < b.time;
  const rank = (kind: Ev["kind"]): number => {
    if (kind === "crash-off") return 0;
    if (kind === "flush") return 1;
    if (kind === "call") return 2;
    return 3;
  };
  return rank(a.kind) < rank(b.kind);
}

/** In-process register with a disk. B05 acknowledges a write before it is durable. */
export function executeRegister(experiment: Experiment): Observation {
  const notes: string[] = [];
  const history: Hist[] = [];
  const build = experiment.bug === "B05" ? "B05" : "correct";
  notes.push("connected register-service · 1 process · build " + build);
  const queue: Ev[] = [];
  for (let i = 0; i < experiment.faults.length; i++) {
    const fault = experiment.faults[i];
    if (!fault || fault.kind !== "crash" || fault.node !== 0) continue;
    queue.push({ time: fault.at, kind: "crash-on" });
    if (fault.until < experiment.maxTimeUs) queue.push({ time: fault.until, kind: "crash-off" });
  }
  for (let i = 0; i < experiment.calls.length; i++) {
    const call = experiment.calls[i];
    if (call) queue.push({ time: call.at, kind: "call", call });
  }
  const disk: Record<string, string> = {};
  let mem: Record<string, string> = {};
  let up = true;
  let gen = 1;
  let steps = 0;
  while (queue.length > 0) {
    let pick = 0;
    for (let i = 1; i < queue.length; i++) {
      const cur = queue[i];
      const best = queue[pick];
      if (cur && best && earlier(cur, best)) pick = i;
    }
    const ev = queue.splice(pick, 1)[0];
    if (!ev || ev.time > experiment.maxTimeUs) continue;
    steps += 1;
    if (ev.kind === "crash-on") {
      up = false;
      mem = {};
      gen += 1;
      notes.push("power cut n0 at " + ms(ev.time));
    } else if (ev.kind === "crash-off") {
      up = true;
      mem = copy(disk);
      notes.push("n0 restarts at " + ms(ev.time));
    } else if (ev.kind === "flush") {
      if (up && ev.gen === gen) disk[ev.key] = ev.value;
    } else if (ev.kind === "call" && up) {
      history.push(writeCall(ev.call, ev.time, mem, disk, build, gen, queue, notes));
    } else if (ev.kind === "call") {
      history.push(record(ev.call, ev.time, "timeout", notes));
    }
  }
  return { history, notes, samples: [], steps };
}

function writeCall(
  call: WorkItem,
  time: number,
  mem: Record<string, string>,
  disk: Record<string, string>,
  build: string,
  gen: number,
  queue: Ev[],
  notes: string[],
): Hist {
  if (call.op === "get") return record(call, time, readKey(mem, call.key), notes);
  if (call.op === "add") {
    const next = String(intOf(readKey(mem, call.key)) + intOf(call.value));
    mem[call.key] = next;
    if (build === "B05") queue.push({ time: time + FLUSH, kind: "flush", gen, key: call.key, value: next });
    else disk[call.key] = next;
    return record(call, time, next, notes);
  }
  mem[call.key] = call.value;
  if (build === "B05") queue.push({ time: time + FLUSH, kind: "flush", gen, key: call.key, value: call.value });
  else disk[call.key] = call.value;
  return record(call, time, "ok", notes);
}

function record(call: WorkItem, time: number, result: string, notes: string[]): Hist {
  const shown = result === "" ? "empty" : result;
  const what =
    call.op === "put" ? "put " + call.key + "=" + call.value : call.op === "add" ? "add " + call.key : "get " + call.key;
  notes.push("c" + call.client + " " + what + " → " + shown + " at " + ms(time));
  return {
    client: call.client,
    seq: call.seq,
    op: call.op,
    key: call.key,
    value: call.value,
    result,
    start: time,
    end: time + 1,
  };
}

export const registerAdapter: SystemAdapter = {
  id: "register-service",
  label: "Single-node register",
  execute: executeRegister,
};
