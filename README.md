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

**Hunt** steps the built-in simulator. Press **Hunt this fault**, scrub the trace, then **Copy replay**. The link (`?r=`) replays that same simulated run.

**Live** is the execution layer. It does not step the simulator. Pick **Raft service** or **Register service**, then press **Run on the live service**. Faultline starts that service, injects crashes and partitions, and checks only the replies and status pages that come back. **Copy replay** stores that experiment (`?e=`). Run it twice and the hash matches.

The register has two builds. **Correct** flushes a write before acknowledging it, so the crash does not lose it. **Amnesia** acknowledges first. Any other chip runs the correct register on purpose.

**Race** compares a guided search with random schedules inside the simulator. The counts are for that run only.

| Chip | What is wrong |
| --- | --- |
| Optimistic match | The leader pretends every peer is already caught up |
| Blind vote | A vote ignores whether the candidate's log is up to date |
| Self quorum | The leader counts itself as a majority |
| Double vote | A node can vote twice in one term |
| Amnesia | Restart wipes the log, or the register flushes too late |
| Stale read | A leader answers reads with no quorum check |
| Skip odd entries | The state machine never applies odd log indexes |
| Retry applies twice | A client retry is not deduplicated |

**Correct Raft** is a soundness spot-check and should stay clean, in the simulator and on the live Raft service.

## Engine tests

These run as part of `npm test`, and on their own:

```bash
npm run test:faultline
```

That checks the simulator zoo, replay rejection, linearizability past ten operations, the live Raft service, and the register.

GitHub Actions (`.github/workflows/ci.yml`) typechecks, runs those tests, builds, and clicks through the production preview in a browser.

## Production build

```bash
npm run build
npm run preview
```

Vite's preview server prints the local URL (port 8081).

## Adding a system

Implement `SystemAdapter` in `src/faultline/live/` (`execute` returns client history and status pages only) and register it in `src/faultline/live/runner.ts`. The checker does not import the service. The two adapters in this repo run inside the page so you can try the connector with nothing else installed. A remote database would be another adapter, not a change to the lab.

## Layout

- `src/faultline/` — kernel, Raft, bug catalog, hunter, replay codec
- `src/faultline/live/` — adapters, runner, black-box checks
- `src/components/` — seismograph and lab console
- `src/routes/` — the page
- `docs/adr/` — what this lab does and does not claim

