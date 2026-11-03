# ADR 0001 — Spec gap and client model

Status: accepted

The attached blueprint ends in the master prompt. Sections 6–19 were not in the file.

The browser lab implements P0 from sections 0–5: keyed randomness, virtual time, a Raft key-value bug zoo, linearizability, ddmin, and replay ids.

Client replies are recorded in-process. Inter-node messages are delayed by `keyed(seed, latency, from, to, linkSeq)` and cancelled when the sender crashes.
