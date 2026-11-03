/** Oracles: exactly-once replay, cluster safety, and linearizability. */

import { intOf } from "./keyed.ts";
import type { BugId, Hist, LogEntry, Node, Violation } from "./types.ts";

/** Observed value of a key. Counters start at 0, registers at empty. */
export function readKey(kv: Record<string, string>, key: string): string {
  const v = kv[key];
  if (v !== undefined) return v;
  if (key === "c") return "0";
  return "";
}

/**
 * Replay a prefix of the log. `bug` selects the state-machine defect:
 * B07 skips odd indexes, B11 applies the same client sequence twice.
 * The spec replay always uses `"correct"`.
 */
export function fold(log: LogEntry[], applied: number, bug: BugId): Record<string, string> {
  const kv: Record<string, string> = {};
  const seen: Record<string, boolean> = {};
  const limit = applied < log.length ? applied : log.length - 1;
  for (let i = 1; i <= limit; i++) {
    const e = log[i];
    if (!e || !e.cmd) continue;
    if (bug === "B07" && i % 2 === 1) continue;
    const id = e.cmd.client + ":" + e.cmd.seq;
    if (bug !== "B11" && seen[id]) continue;
    seen[id] = true;
    if (e.cmd.op === "put") kv[e.cmd.key] = e.cmd.value;
    else {
      const cur = intOf(kv[e.cmd.key] ?? "0");
      kv[e.cmd.key] = String(cur + intOf(e.cmd.value));
    }
  }
  return kv;
}

function kvEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = uniqueKeys(a, b);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (!k) continue;
    if ((a[k] ?? "") !== (b[k] ?? "")) return false;
  }
  return true;
}

function uniqueKeys(a: Record<string, string>, b: Record<string, string>): string[] {
  const out: string[] = [];
  pushKeys(out, a);
  pushKeys(out, b);
  out.sort();
  return out;
}

function pushKeys(out: string[], kv: Record<string, string>): void {
  const keys = Object.keys(kv);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (!k) continue;
    let found = false;
    for (let j = 0; j < out.length; j++) if (out[j] === k) found = true;
    if (!found) out.push(k);
  }
}

function kvDiff(got: Record<string, string>, spec: Record<string, string>): string {
  const keys = uniqueKeys(got, spec);
  const parts: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (!k) continue;
    const g = got[k] ?? "";
    const s = spec[k] ?? "";
    if (g !== s) parts.push(k + " is " + (g === "" ? "empty" : g) + " but replay says " + (s === "" ? "empty" : s));
  }
  return parts.join("; ");
}

function cmdLabel(e: LogEntry | undefined): string {
  if (!e || !e.cmd) return "noop";
  if (e.cmd.op === "put") return "put " + e.cmd.key + "=" + e.cmd.value;
  return "add " + e.cmd.key + "+" + e.cmd.value;
}

/** Dual leaders, divergent committed entries, and state-machine disagreement. */
export function checkSafety(nodes: Node[], bug: BugId, time: number, event: number): Violation | null {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (!a || !b) continue;
      if (a.alive && b.alive && a.role === "leader" && b.role === "leader" && a.term === b.term) {
        return {
          kind: "dual-leader",
          time,
          event,
          detail:
            "Nodes " + a.id + " and " + b.id + " are both leader in term " + a.term + ".",
        };
      }
    }
  }
  let maxC = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n && n.commit > maxC) maxC = n.commit;
  }
  for (let index = 1; index <= maxC; index++) {
    let seen: LogEntry | null = null;
    let seenId = -1;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n || n.commit < index) continue;
      const e = n.log[index];
      if (!e) continue;
      if (!seen) {
        seen = e;
        seenId = n.id;
        continue;
      }
      if (seen.term !== e.term || !sameCmd(seen, e)) {
        return {
          kind: "divergent-commit",
          time,
          event,
          detail:
            "Committed index " +
            index +
            " is " +
            cmdLabel(seen) +
            " on n" +
            seenId +
            " and " +
            cmdLabel(e) +
            " on n" +
            n.id +
            ".",
        };
      }
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    const spec = fold(n.log, n.applied, "correct");
    const got = fold(n.log, n.applied, bug);
    if (!kvEqual(spec, got)) {
      return {
        kind: "apply",
        time,
        event,
        detail: "Node " + n.id + " state disagrees with exactly-once replay (" + kvDiff(got, spec) + ").",
      };
    }
  }
  return null;
}

function sameCmd(a: LogEntry, b: LogEntry): boolean {
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

function modelStep(state: string, op: Hist): string | null {
  if (op.op === "put") {
    if (op.result !== "ok") return null;
    return op.value;
  }
  if (op.op === "add") {
    const next = String(intOf(state) + intOf(op.value));
    if (op.result !== next) return null;
    return next;
  }
  if (op.result !== state) return null;
  return state;
}

function search(rem: Hist[], state: string): boolean {
  if (rem.length === 0) return true;
  for (let i = 0; i < rem.length; i++) {
    const op = rem[i];
    if (!op) continue;
    let blocked = false;
    for (let j = 0; j < rem.length; j++) {
      const other = rem[j];
      if (!other || other === op) continue;
      if (other.end < op.start) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    const next = modelStep(state, op);
    if (next === null) continue;
    const rest: Hist[] = [];
    for (let j = 0; j < rem.length; j++) {
      if (j !== i) {
        const h = rem[j];
        if (h) rest.push(h);
      }
    }
    if (search(rest, next)) return true;
  }
  return false;
}

function histLine(h: Hist): string {
  const what =
    h.op === "put" ? "put " + h.key + "=" + h.value : h.op === "add" ? "add " + h.key + "+" + h.value : "get " + h.key;
  return "c" + h.client + " " + what + " → " + (h.result === "" ? "empty" : h.result) + " @" + h.start + "–" + h.end;
}

/** Linearizability per key. Empty history is valid. */
export function checkLinear(history: Hist[], time: number, event: number): Violation | null {
  const keys = uniqueHistKeys(history);
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    if (!key) continue;
    const ops: Hist[] = [];
    for (let i = 0; i < history.length; i++) {
      const h = history[i];
      if (h && h.key === key) ops.push(h);
    }
    if (ops.length > 10) continue;
    const counter = key === "c" || ops.some((o) => o.op === "add");
    const ok = search(ops, counter ? "0" : "");
    if (!ok) {
      const lines: string[] = [];
      for (let i = 0; i < ops.length; i++) {
        const h = ops[i];
        if (h) lines.push(histLine(h));
      }
      return {
        kind: "linearizability",
        time,
        event,
        detail: "History for key " + key + " is not linearizable. " + lines.join(" · "),
      };
    }
  }
  return null;
}

function uniqueHistKeys(history: Hist[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (!h) continue;
    let found = false;
    for (let j = 0; j < out.length; j++) if (out[j] === h.key) found = true;
    if (!found) out.push(h.key);
  }
  out.sort();
  return out;
}
