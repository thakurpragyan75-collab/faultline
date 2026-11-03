# ADR 0003 — External disk process

Status: accepted

The in-page Raft service and register are still reference adapters. They share this repository's code. They are not a test of someone else's software.

`targets/kv-server.mjs` is a separate program. It does not import Faultline. It keeps keys in memory and in a real file, and it calls `fsync` on that file. Faultline's connector (`runExternal`) speaks HTTP only: reset, put, crash, wait for a new process id, then get. The checker sees the replies and the status page. It does not read the server's variables.

Two builds ship in that program:

- `fsync` writes the file before the acknowledgement.
- `volatile` (Amnesia) acknowledges first and writes the file about two seconds later. A crash cancels that write. The supervisor starts a new process on the same directory, which reloads only what was fsynced.

Replay of an external run repeats those HTTP calls. It matches only while the target build is the same. This is not a connection to etcd, Postgres, or a production cluster.
