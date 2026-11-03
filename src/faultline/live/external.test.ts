import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { externalExperiment, runExternal } from "./external.ts";
import { startTarget, stopTarget } from "./target-process.ts";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

test("the external disk process is not Faultline's register", () => {
  const source = readFileSync(path.join(process.cwd(), "targets", "kv-server.mjs"), "utf8");
  assert.equal(source.includes("faultline"), false);
  assert.equal(source.includes("register-service"), false);
  assert.match(source, /fsyncSync/);
});

test("volatile build loses an acked put when the process is killed; durable build keeps the file", async () => {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), "faultline-ext-"));
  const base = startTarget(port, dir);
  try {
    const broken = await runExternal(externalExperiment("B05"), base);
    assert.equal(broken.violation?.kind, "linearizability");
    assert.match(broken.notes.join("\n"), /separate process/);
    assert.match(broken.notes.join("\n"), /put a=1 → ok/);
    assert.match(broken.notes.join("\n"), /get a → empty/);
    assert.match(broken.notes.join("\n"), /acked before fsync/);
    const file = readFileSync(path.join(dir, "disk.json"), "utf8");
    assert.equal(JSON.parse(file).a, undefined);

    const again = await runExternal(externalExperiment("B05"), base);
    assert.equal(again.hash, broken.hash);

    const sound = await runExternal(externalExperiment("correct"), base);
    assert.equal(sound.violation, null, sound.violation?.detail ?? "");
    assert.match(sound.notes.join("\n"), /get a → 1/);
    assert.match(sound.notes.join("\n"), /fsynced before ack/);
    const kept = JSON.parse(readFileSync(path.join(dir, "disk.json"), "utf8")) as { a?: string };
    assert.equal(kept.a, "1");
  } finally {
    await stopTarget(port);
    rmSync(dir, { recursive: true, force: true });
  }
});
