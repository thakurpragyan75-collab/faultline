#!/usr/bin/env node
/**
 * Independent key-value process.
 *
 * This file does not import Faultline. It is a separate program with its own
 * memory and a real file. Faultline may only talk to it over HTTP.
 *
 * Builds:
 *   fsync     — the write is on disk before the ack
 *   volatile  — the ack returns first; the file is written about two seconds later
 *
 * A crash is process.exit. Anything not yet fsynced dies with the process.
 * A supervisor may start the same data directory again; this process reloads the file.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const VERSION = "kv-server-1";
const FLUSH_MS = 2000;

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const port = Number(arg("--port", "8091"));
const dir = arg("--dir", path.join(process.cwd(), ".data", "kv"));
fs.mkdirSync(dir, { recursive: true });
const diskPath = path.join(dir, "disk.json");

let mode = "fsync";
let memory = readDisk();
let generation = 1;
const log = [];
let flushTimer = null;

function note(line) {
  log.push(line);
  if (log.length > 48) log.shift();
}

function readDisk() {
  try {
    const parsed = JSON.parse(fs.readFileSync(diskPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function fsyncDisk(obj) {
  const tmp = diskPath + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(obj));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, diskPath);
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    fsyncDisk(memory);
    note("flushed memory to " + diskPath);
  }, FLUSH_MS);
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 65536) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function short(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 32 ? value : null;
}

function handleOp(body) {
  const op = body.op;
  const key = short(body.key);
  if (!key || (op !== "put" && op !== "get")) {
    return { id: body.id ?? 0, ok: false, value: "", timeout: true };
  }
  if (op === "get") {
    const hit = Object.prototype.hasOwnProperty.call(memory, key);
    const value = hit ? String(memory[key]) : "";
    note("get " + key + " → " + (value === "" ? "empty" : value));
    return { id: body.id ?? 0, ok: true, value, timeout: false };
  }
  const value = short(body.value);
  if (value === null) return { id: body.id ?? 0, ok: false, value: "", timeout: true };
  memory[key] = value;
  if (mode === "fsync") {
    fsyncDisk(memory);
    note("put " + key + "=" + value + " fsynced before ack");
  } else {
    note("put " + key + "=" + value + " acked before fsync");
    scheduleFlush();
  }
  return { id: body.id ?? 0, ok: true, value: "ok", timeout: false };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, { ok: true, pid: process.pid, version: VERSION });
    return;
  }
  if (req.method === "GET" && url.pathname === "/status") {
    send(res, 200, {
      pid: process.pid,
      version: VERSION,
      mode,
      generation,
      alive: true,
      memory: { ...memory },
      disk: readDisk(),
      diskPath,
      log: log.slice(),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/disk") {
    send(res, 200, { disk: readDisk(), path: diskPath, version: VERSION });
    return;
  }
  if (req.method !== "POST") {
    send(res, 404, { error: "not found" });
    return;
  }
  readBody(req)
    .then((body) => {
      if (url.pathname === "/reset") {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        mode = body.mode === "volatile" ? "volatile" : "fsync";
        memory = {};
        generation += 1;
        fsyncDisk({});
        log.length = 0;
        note("reset mode=" + mode + " file=" + diskPath);
        send(res, 200, { ok: true, mode, pid: process.pid, version: VERSION, diskPath });
        return;
      }
      if (url.pathname === "/op") {
        send(res, 200, handleOp(body));
        return;
      }
      if (url.pathname === "/crash") {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        note("crash, unflushed memory discarded");
        send(res, 200, { ok: true, crashed: true, pid: process.pid });
        res.on("finish", () => {
          setTimeout(() => process.exit(1), 20);
        });
        return;
      }
      send(res, 404, { error: "not found" });
    })
    .catch(() => {
      if (!res.headersSent) send(res, 400, { error: "bad request" });
    });
});

server.on("error", () => {
  process.exit(1);
});

server.listen(port, "127.0.0.1");
