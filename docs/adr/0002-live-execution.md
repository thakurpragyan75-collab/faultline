# ADR 0002 — Live execution layer

Status: accepted

The simulation lab (`runScenario`) is unchanged. Live mode is a second path.

Faultline's runner talks only to a `SystemAdapter`. It injects a fault schedule, records client replies and status pages, then checks those observations. It does not import the service's protocol code.

Two reference adapters ship in the page so the lab runs with nothing else installed:

- `raft-service` hosts the audited Raft processes. Crashes, partitions, and mutes are applied by the connector. Verification is linearizability of the replies, plus dual-leader and divergent-commit alarms scraped from status pages.
- `register-service` is a one-process register with a disk. The correct build flushes before it acknowledges. The amnesia build (B05) acknowledges first; a crash before the flush drops the write.

An outside system plugs in by implementing `SystemAdapter` and registering it in the runner. This lab does not attach to etcd, FoundationDB, or a remote cluster. Those would be further adapters, not a change to the checker.

Replay of a live run is a separate token (`?e=`). A forged or oversized payload is rejected. Two executions of the same experiment share a hash because the service clock is the seeded virtual clock, not the wall clock.
