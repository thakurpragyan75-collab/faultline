/** Starts the independent disk process and restarts it after a crash. Same directory, so the file survives. */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type Slot = {
  port: number;
  dir: string;
  child: ChildProcess | null;
  stopped: boolean;
  launching: boolean;
};

const slots = new Map<number, Slot>();

function scriptPath(): string {
  return path.join(process.cwd(), "targets", "kv-server.mjs");
}

function launch(slot: Slot): void {
  if (slot.stopped || slot.child || slot.launching) return;
  slot.launching = true;
  const child = spawn(process.execPath, [scriptPath(), "--port", String(slot.port), "--dir", slot.dir], {
    stdio: "ignore",
  });
  slot.child = child;
  slot.launching = false;
  child.on("exit", () => {
    if (slot.child === child) slot.child = null;
    if (!slot.stopped) setTimeout(() => launch(slot), 40);
  });
}

export function startTarget(port: number, dir?: string): string {
  const folder = dir ?? path.join(tmpdir(), "faultline-kv-" + String(port));
  mkdirSync(folder, { recursive: true });
  let slot = slots.get(port);
  if (!slot || slot.stopped) {
    slot = { port, dir: folder, child: null, stopped: false, launching: false };
    slots.set(port, slot);
  }
  if (dir && slot.dir !== folder && !slot.child) slot.dir = folder;
  launch(slot);
  return "http://127.0.0.1:" + String(port);
}

export function stopTarget(port: number): Promise<void> {
  const slot = slots.get(port);
  if (!slot) return Promise.resolve();
  slot.stopped = true;
  slots.delete(port);
  const child = slot.child;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once("exit", done);
    child.kill("SIGKILL");
    setTimeout(done, 800);
  });
}

async function health(base: string): Promise<{ pid: number } | null> {
  try {
    const res = await fetch(base + "/health");
    if (!res.ok) return null;
    const body = (await res.json()) as { pid?: number };
    if (typeof body.pid !== "number") return null;
    return { pid: body.pid };
  } catch {
    return null;
  }
}

/** Reuse a healthy process, or start one and wait until it answers. */
export async function ensureTarget(port: number): Promise<string> {
  const base = "http://127.0.0.1:" + String(port);
  if (await health(base)) return base;
  startTarget(port);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await health(base)) return base;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("The external disk process did not start on port " + String(port) + ".");
}
