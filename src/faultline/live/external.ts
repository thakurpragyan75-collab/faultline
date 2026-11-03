/**
 * Connector for the separate kv-server process.
 * This module speaks HTTP only. It does not import the server, Raft, or the in-page register.
 */

import type { BugId, Hist, Violation } from "../types.ts";
import { reportFromObservation } from "./runner.ts";
import type { Experiment, LiveReport, Observation, Status } from "./types.ts";

type Json = Record<string, unknown>;

async function call(base: string, pathname: string, body?: Json): Promise<Json> {
  const res = await fetch(base + pathname, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Json;
  } catch {
    parsed = {};
  }
  if (!res.ok) throw new Error("target " + pathname + " returned " + String(res.status));
  return parsed;
}

async function waitPid(base: string, notPid: number): Promise<number> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const body = await call(base, "/health");
      const pid = body.pid;
      if (typeof pid === "number" && pid !== notPid) return pid;
    } catch {
      // process is down between the crash and the supervisor's restart
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("The disk process did not restart after the crash.");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function mapStatus(body: Json): Status {
  const disk = body.disk && typeof body.disk === "object" ? (body.disk as Record<string, unknown>) : {};
  const entries = Object.keys(disk).map((key) => key + "=" + str(disk[key]));
  return {
    id: typeof body.pid === "number" ? body.pid : 0,
    role: str(body.mode) || "disk",
    term: typeof body.generation === "number" ? body.generation : 0,
    alive: body.alive !== false,
    commit: entries.length,
    entries,
  };
}

/** Preset against the external process. Only Amnesia loads the volatile build. */
export function externalExperiment(bug: BugId): Experiment {
  return {
    seed: 1,
    target: "external-kv",
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

/**
 * Drive a process Faultline did not implement.
 * Reset, put, crash the OS process, wait for a new pid on the same directory, get.
 */
export async function runExternal(experiment: Experiment, base: string): Promise<LiveReport> {
  const mode = experiment.bug === "B05" ? "volatile" : "fsync";
  const putCall = experiment.calls.find((item) => item.op === "put");
  const getCall = experiment.calls.find((item) => item.op === "get");
  const put = putCall ?? { at: 50_000, client: 0, seq: 1, node: 0, op: "put" as const, key: "a", value: "1" };
  const get = getCall ?? { at: 300_000, client: 1, seq: 1, node: 0, op: "get" as const, key: put.key, value: "" };
  const notes: string[] = [];
  const samples: Status[][] = [];
  let steps = 0;
  await waitPid(base, -1);

  const reset = await call(base, "/reset", { mode });
  steps += 1;
  const firstPid = typeof reset.pid === "number" ? reset.pid : 0;
  notes.push(
    "separate process pid " +
      String(firstPid) +
      " version " +
      str(reset.version) +
      " build " +
      mode +
      " file " +
      str(reset.diskPath),
  );

  const wrote = await call(base, "/op", { id: 1, op: "put", key: put.key, value: put.value });
  steps += 1;
  const putResult = wrote.ok === true && wrote.timeout !== true ? "ok" : "timeout";
  notes.push("put " + put.key + "=" + put.value + " → " + putResult);

  const before = await call(base, "/status");
  steps += 1;
  samples.push([mapStatus(before)]);
  const beforeDisk = before.disk && typeof before.disk === "object" ? (before.disk as Record<string, unknown>) : {};
  notes.push("status before crash: disk " + put.key + "=" + (str(beforeDisk[put.key]) || "empty"));
  const beforeLog = Array.isArray(before.log) ? before.log : [];
  for (let i = 0; i < beforeLog.length; i++) notes.push("log: " + str(beforeLog[i]));

  await call(base, "/crash", {});
  steps += 1;
  notes.push("crash killed pid " + String(firstPid) + "; waiting for a new process on the same file");
  const nextPid = await waitPid(base, firstPid);
  steps += 1;
  notes.push("restarted as pid " + String(nextPid));

  const disk = await call(base, "/disk");
  steps += 1;
  const diskMap = disk.disk && typeof disk.disk === "object" ? (disk.disk as Record<string, unknown>) : {};
  notes.push("disk file after restart: " + put.key + "=" + (str(diskMap[put.key]) || "empty") + " path " + str(disk.path));

  const read = await call(base, "/op", { id: 2, op: "get", key: get.key });
  steps += 1;
  const got = read.timeout === true ? "timeout" : str(read.value);
  notes.push("get " + get.key + " → " + (got === "" ? "empty" : got));

  const after = await call(base, "/status");
  steps += 1;
  samples.push([mapStatus(after)]);
  const lines = Array.isArray(after.log) ? after.log : [];
  for (let i = 0; i < lines.length; i++) notes.push("log: " + str(lines[i]));

  const history: Hist[] = [
    {
      client: put.client,
      seq: put.seq,
      op: "put",
      key: put.key,
      value: put.value,
      result: putResult,
      start: put.at,
      end: put.at + 1,
    },
    {
      client: get.client,
      seq: get.seq,
      op: "get",
      key: get.key,
      value: "",
      result: got,
      start: get.at,
      end: get.at + 1,
    },
  ];
  const obs: Observation = { history, notes, samples, steps };
  return reportFromObservation(obs, experiment.maxTimeUs, 1);
}

export function externalViolation(report: LiveReport): Violation | null {
  return report.violation;
}
