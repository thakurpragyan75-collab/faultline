# Faultline

A seismograph for a deterministic Raft cluster. One seed drives time, the network, and crashes, so a failure you find can be replayed from a link.

This repository is the same app as the live lab. The browser console hunts a bug zoo. The kernel under `src/faultline` is integer-only: keyed randomness, virtual microseconds, a three-node Raft, linearizability checks, schedule shrinking, and shareable replay ids. Nothing in the simulator uses `Math.random`.

## Run it locally

You need Node.js 22.

```bash
git clone https://github.com/thakurpragyan75-collab/faultline.git
cd faultline
npm install
npm run dev
```

Open [http://localhost:8080](http://localhost:8080).

No account and no database are required. Leave `.grok/app-env.json` in place. It turns auth off for this lab. If it is missing, the dev server does not match the published app.

`npm run build` skips database migrations when `DATABASE_URL` is unset, which is the normal local case.

## What to try

**Self quorum** is selected when you open the lab.

1. Press **Hunt this fault**. The hunter runs schedules until a write is acknowledged and then lost, shrinks that schedule, and draws the three nodes.
2. Scrub the trace, or press play.
3. Press **Copy replay**. The link (`?r=`) replays that same run.

The other chips are the same seeded safety bugs:

| Chip | What is wrong |
| --- | --- |
| Optimistic match | The leader pretends every peer is already caught up |
| Blind vote | A vote ignores whether the candidate's log is up to date |
| Double vote | A node can vote twice in one term |
| Amnesia | Restart wipes the log, the term, and the vote |
| Stale read | A leader answers reads with no quorum check |
| Skip odd entries | The state machine never applies odd log indexes |
| Retry applies twice | A client retry is not deduplicated |

**Race** compares a guided search with random schedules. The counts are for that run only. **Correct Raft** is a soundness spot-check and should stay clean.

## Engine tests

```bash
node --experimental-strip-types --test src/faultline/engine.test.ts
```

That checks that every bug in the zoo is found, that the correct Raft stays clean, that fast and recorded runs hash the same, and that a shrunk replay still fails and round-trips.

## Production build

```bash
npm run build
npm run preview
```

Vite's preview server prints the local URL (port 4173 by default).

## Layout

- `src/faultline/` — kernel, Raft, bug catalog, hunter, replay codec
- `src/components/` — seismograph and lab console
- `src/routes/` — the page
- `docs/adr/0001-spec-gap.md` — what this lab does and does not claim
