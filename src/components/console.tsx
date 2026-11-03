import { useEffect, useRef, useState } from "react";
import { Activity, Check, Copy, Pause, Play, Shield } from "lucide-react";
import { Crust } from "@/components/crust";
import {
  ZOO,
  bugInfo,
  candidates,
  decodeExperiment,
  decodeReplay,
  encodeExperiment,
  encodeReplay,
  narrate,
  raftExperiment,
  randomScenario,
  registerExperiment,
  runExperiment,
  runScenario,
  shrinkExperiment,
  shrinkScenario,
} from "@/faultline/index.ts";
import type { BugId, Frame, LiveReport, Outcome, Scenario, TargetId } from "@/faultline/index.ts";

type Phase = "idle" | "hunting" | "found" | "clean";
type Mode = "hunt" | "race" | "live";

type Race = {
  guided: number;
  random: number;
  guidedFound: boolean;
  randomFound: boolean;
  done: boolean;
};

function wait(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Seismograph: hunt the bug zoo, shrink the trace, scrub it. */
export function Console() {
  const [bug, setBug] = useState<BugId>("B03");
  const [mode, setMode] = useState<Mode>("hunt");
  const [phase, setPhase] = useState<Phase>("idle");
  const [trials, setTrials] = useState(0);
  const [budget, setBudget] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [beforeEvents, setBeforeEvents] = useState(0);
  const [shrinkRuns, setShrinkRuns] = useState(0);
  const [note, setNote] = useState("");
  const [play, setPlay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [race, setRace] = useState<Race | null>(null);
  const [target, setTarget] = useState<TargetId>("raft-service");
  const [live, setLive] = useState<LiveReport | null>(null);
  const run = useRef(0);
  const info = bugInfo(bug);
  const frames: Frame[] = outcome?.frames ?? [];

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const liveToken = params.get("e");
    if (liveToken) {
      const experiment = decodeExperiment(liveToken);
      if (experiment) {
        const report = runExperiment(experiment);
        setMode("live");
        setTarget(experiment.target);
        setBug(experiment.bug);
        setLive(report);
        setNote(report.violation ? report.violation.detail : report.notes[0] ?? "Service stayed inside the rules.");
        setPhase(report.violation ? "found" : "clean");
        return;
      }
    }
    const token = params.get("r");
    if (!token) return;
    const decoded = decodeReplay(token);
    if (!decoded) return;
    const recorded = runScenario(decoded, "record");
    setBug(decoded.bug);
    setScenario(decoded);
    setOutcome(recorded);
    setNote(narrate(decoded.bug, recorded));
    setPhase(recorded.violation ? "found" : "clean");
    setPlay(Math.max(0, recorded.frames.length - 1));
    setPlaying(false);
  }, []);

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPlay(frames.length - 1);
      setPlaying(false);
      return;
    }
    let raf = 0;
    let last = 0;
    const tick = (time: number) => {
      if (time - last > 28) {
        last = time;
        setPlay((current) => {
          if (current >= frames.length - 1) {
            setPlaying(false);
            return frames.length - 1;
          }
          return current + 2;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, frames.length]);

  async function hunt(next: BugId) {
    const id = ++run.current;
    setMode("hunt");
    setBug(next);
    setPhase("hunting");
    setOutcome(null);
    setScenario(null);
    setNote("");
    setPlaying(false);
    setPlay(0);
    const list = candidates(next);
    setBudget(list.length);
    setTrials(0);
    for (let i = 0; i < list.length; i++) {
      if (run.current !== id) return;
      const sample = list[i];
      if (!sample) continue;
      const fast = runScenario(sample, "fast");
      setTrials(i + 1);
      if (i % 2 === 0) await wait();
      if (!fast.violation) continue;
      const shrunk = shrinkScenario(sample);
      if (run.current !== id) return;
      const recorded = runScenario(shrunk.scenario, "record");
      setBeforeEvents(fast.events);
      setShrinkRuns(shrunk.runs);
      setScenario(shrunk.scenario);
      setOutcome(recorded);
      setNote(narrate(next, recorded));
      setPhase("found");
      setPlay(0);
      setPlaying(true);
      const token = encodeReplay(shrunk.scenario);
      const url = new URL(window.location.href);
      url.searchParams.set("r", token);
      window.history.replaceState(null, "", url);
      return;
    }
    if (run.current !== id) return;
    setPhase("clean");
    setNote(
      next === "correct"
        ? "Sound. " + list.length + " scenarios, 0 violations."
        : "No violation inside this budget. That is a measured miss, not a proof of absence.",
    );
  }

  async function startRace(next: BugId) {
    const id = ++run.current;
    setMode("race");
    setBug(next);
    setPhase("hunting");
    setRace({ guided: 0, random: 0, guidedFound: false, randomFound: false, done: false });
    const guided = candidates(next);
    let g = 0;
    let r = 0;
    let gf = false;
    let rf = false;
    const limit = 36;
    for (let i = 0; i < limit; i++) {
      if (run.current !== id) return;
      if (!gf) {
        const sample = guided[i];
        if (sample) {
          g += 1;
          if (runScenario(sample, "fast").violation) gf = true;
        } else gf = true;
      }
      if (!rf) {
        r += 1;
        if (runScenario(randomScenario(next, 100 + i), "fast").violation) rf = true;
      }
      setRace({ guided: g, random: r, guidedFound: gf, randomFound: rf, done: false });
      if (gf && rf) break;
      await wait();
    }
    if (run.current !== id) return;
    setRace({ guided: g, random: r, guidedFound: gf, randomFound: rf, done: true });
    setPhase(gf || rf ? "found" : "clean");
  }

  async function runLive(next: BugId, which: TargetId) {
    const id = ++run.current;
    setMode("live");
    setBug(next);
    setTarget(which);
    setPhase("hunting");
    setOutcome(null);
    setLive(null);
    setNote("");
    setPlaying(false);
    await wait();
    if (run.current !== id) return;
    const experiment = which === "register-service" ? registerExperiment(next) : raftExperiment(next);
    let report = runExperiment(experiment);
    let used = experiment;
    if (report.violation) {
      const shrunk = shrinkExperiment(experiment);
      const again = runExperiment(shrunk.experiment);
      if (again.violation) {
        used = shrunk.experiment;
        report = { ...again, runs: shrunk.runs };
      }
    }
    if (run.current !== id) return;
    setLive(report);
    setNote(
      report.violation
        ? report.violation.detail
        : which === "register-service" && next !== "B05" && next !== "correct"
          ? "This register build is correct. The crash did not lose the write. Pick Amnesia to see the defective build."
          : "The service answered inside the rules. Hash " + report.hash.toString(16) + ".",
    );
    setPhase(report.violation ? "found" : "clean");
    const url = new URL(window.location.href);
    url.searchParams.delete("r");
    url.searchParams.set("e", encodeExperiment(used));
    window.history.replaceState(null, "", url);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  const frame = frames[Math.min(play, Math.max(0, frames.length - 1))];
  const status =
    phase === "hunting"
      ? mode === "race"
        ? "Racing guided search against plain random."
        : mode === "live"
          ? "Driving the connected service."
          : "Trial " + trials + " of " + budget + "."
      : phase === "found"
        ? "Violation held still."
        : phase === "clean"
          ? "Nothing broke."
          : mode === "live"
            ? "Connect a service and run the schedule against it."
            : "Pick a fault and run the hunt.";

  return (
    <main className="min-h-dvh overflow-x-hidden bg-ink text-paper">
      <header className="border-b border-line px-4 py-4 lg:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-display text-4xl italic leading-none text-paper">Faultline</p>
            <p className="mt-2 text-sm text-muted">Deterministic Raft lab · live service connector</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode("hunt")}
              className={
                "min-h-11 rounded-card border px-4 text-sm " +
                (mode === "hunt" ? "border-amber bg-panel-2 text-paper" : "border-line bg-panel text-muted")
              }
            >
              Hunt
            </button>
            <button
              type="button"
              onClick={() => setMode("race")}
              className={
                "min-h-11 rounded-card border px-4 text-sm " +
                (mode === "race" ? "border-amber bg-panel-2 text-paper" : "border-line bg-panel text-muted")
              }
            >
              Race
            </button>
            <button
              type="button"
              onClick={() => setMode("live")}
              className={
                "min-h-11 rounded-card border px-4 text-sm " +
                (mode === "live" ? "border-amber bg-panel-2 text-paper" : "border-line bg-panel text-muted")
              }
            >
              Live
            </button>
          </div>
        </div>
      </header>

      <div className="grid gap-0 lg:grid-cols-[18rem_minmax(0,1fr)_22rem]">
        <section className="border-line lg:border-r">
          <div className="flex items-center gap-2 px-4 py-3 text-xs uppercase tracking-widest text-muted">
            <Activity className="size-4" aria-hidden />
            Bug zoo
          </div>
          <ul className="flex max-w-full gap-2 overflow-x-auto px-4 pb-4 lg:flex-col lg:overflow-visible lg:px-3">
            {ZOO.map((row) => {
              const selected = row.id === bug;
              return (
                <li key={row.id} className="min-w-56 shrink-0 lg:min-w-0">
                  <button
                    type="button"
                    onClick={() => {
                      setBug(row.id);
                      if (mode !== "live") setMode("hunt");
                    }}
                    className={
                      "flex min-h-11 w-full flex-col items-start rounded-card border px-3 py-2 text-left " +
                      (selected ? "border-oxide bg-panel-2" : "border-line bg-panel")
                    }
                  >
                    <span className="text-xs text-amber">{row.tier}</span>
                    <span className="text-sm text-paper">
                      {row.id === "correct" ? "Correct" : row.id} · {row.name}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="min-w-0 border-line lg:border-r">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <p className="text-sm text-paper">{status}</p>
            <div className="flex gap-2">
              {mode === "hunt" ? (
                <button
                  type="button"
                  onClick={() => void hunt(bug)}
                  disabled={phase === "hunting"}
                  className="inline-flex min-h-11 items-center gap-2 rounded-card bg-oxide px-4 text-sm text-ink disabled:opacity-60"
                >
                  <Play className="size-4" aria-hidden />
                  {bug === "correct" ? "Spot-check soundness" : "Hunt this fault"}
                </button>
              ) : mode === "race" ? (
                <button
                  type="button"
                  onClick={() => void startRace(bug)}
                  disabled={phase === "hunting" || bug === "correct"}
                  className="inline-flex min-h-11 items-center gap-2 rounded-card bg-oxide px-4 text-sm text-ink disabled:opacity-60"
                >
                  <Activity className="size-4" aria-hidden />
                  Race random vs guided
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void runLive(bug, target)}
                  disabled={phase === "hunting"}
                  className="inline-flex min-h-11 items-center gap-2 rounded-card bg-oxide px-4 text-sm text-ink disabled:opacity-60"
                >
                  <Activity className="size-4" aria-hidden />
                  Run on the live service
                </button>
              )}
            </div>
          </div>

          {mode === "live" ? (
            <div className="px-4 pb-4">
              <div className="mb-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setTarget("raft-service")}
                  className={
                    "min-h-11 rounded-card border px-3 text-sm " +
                    (target === "raft-service" ? "border-amber bg-panel-2 text-paper" : "border-line bg-panel text-muted")
                  }
                >
                  Raft service
                </button>
                <button
                  type="button"
                  onClick={() => setTarget("register-service")}
                  className={
                    "min-h-11 rounded-card border px-3 text-sm " +
                    (target === "register-service"
                      ? "border-amber bg-panel-2 text-paper"
                      : "border-line bg-panel text-muted")
                  }
                >
                  Register service
                </button>
              </div>
              <p className="mb-3 text-sm leading-relaxed text-muted">
                {target === "raft-service"
                  ? "Three Raft processes behind the connector. Faultline injects the schedule and reads only replies and status pages."
                  : "One register with a disk. Amnesia acknowledges the write, then a crash arrives before the flush."}
              </p>
              <ol className="max-h-80 space-y-1 overflow-y-auto text-xs text-muted">
                {(live?.notes ?? ["Waiting for a live run."]).map((line, index) => (
                  <li key={index + line} className={line.includes("→ empty") || line.includes("power") ? "text-paper" : undefined}>
                    {line}
                  </li>
                ))}
              </ol>
            </div>
          ) : mode === "race" && race ? (
            <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2">
              <RaceCard label="Guided" trials={race.guided} found={race.guidedFound} />
              <RaceCard label="Random" trials={race.random} found={race.randomFound} />
              <p className="text-sm text-muted sm:col-span-2">
                {race.done
                  ? "Counts are this run only. Guided tries aimed fault schedules first."
                  : "Both searches share the same engine. Neither number is a published benchmark."}
              </p>
            </div>
          ) : (
            <>
              <Crust frames={frames} index={frames.length === 0 ? 0 : play} />
              <div className="flex min-w-0 items-center gap-3 px-4 py-3">
                <button
                  type="button"
                  aria-label={playing ? "Pause replay" : "Play replay"}
                  disabled={frames.length === 0}
                  onClick={() => setPlaying((v) => !v)}
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-card border border-line bg-panel text-paper disabled:opacity-40"
                >
                  {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
                </button>
                <input
                  type="range"
                  className="min-w-0 flex-1"
                  min={0}
                  max={Math.max(0, frames.length - 1)}
                  value={Math.min(play, Math.max(0, frames.length - 1))}
                  onChange={(event) => {
                    setPlaying(false);
                    setPlay(Number(event.target.value));
                  }}
                  aria-label="Trace time"
                  disabled={frames.length === 0}
                />
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted">
                  {frame ? Math.floor(frame.time / 1000) + "ms" : "—"}
                </span>
              </div>
              <ol className="max-h-36 space-y-1 overflow-y-auto px-4 pb-4 text-xs text-muted">
                {frames.slice(Math.max(0, play - 5), play + 1).map((item) => (
                  <li key={item.i + "-" + item.label} className={item.tone === "bad" ? "text-oxide" : undefined}>
                    {item.i} · {item.label}
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>

        <aside className="px-4 py-4 lg:px-5">
          <p className="text-xs uppercase tracking-widest text-amber">{info.id === "correct" ? "Control" : info.id}</p>
          <h1 className="font-display mt-1 text-3xl italic text-paper">{info.name}</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">{info.summary}</p>
          <p className="mt-3 text-sm leading-relaxed text-paper">{info.defect}</p>

          {phase === "found" && live?.violation && mode === "live" ? (
            <div className="mt-5 rounded-card border border-oxide bg-panel p-3">
              <p className="text-xs uppercase tracking-widest text-oxide">{live.violation.kind}</p>
              <p className="mt-2 text-sm leading-relaxed text-paper">{note}</p>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs tabular-nums text-muted">
                <div>
                  <dt>Service steps</dt>
                  <dd className="text-paper">{live.events}</dd>
                </div>
                <div>
                  <dt>Shrink passes</dt>
                  <dd className="text-paper">{live.runs}</dd>
                </div>
                <div>
                  <dt>Observed calls</dt>
                  <dd className="text-paper">{live.history.length}</dd>
                </div>
                <div>
                  <dt>Hash</dt>
                  <dd className="truncate text-paper">{live.hash.toString(16)}</dd>
                </div>
              </dl>
              <button
                type="button"
                onClick={() => void copyLink()}
                className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm text-amber"
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Link copied" : "Copy replay link"}
              </button>
            </div>
          ) : null}

          {phase === "found" && outcome?.violation && mode === "hunt" ? (
            <div className="mt-5 rounded-card border border-oxide bg-panel p-3">
              <p className="text-xs uppercase tracking-widest text-oxide">{outcome.violation.kind}</p>
              <p className="mt-2 text-sm leading-relaxed text-paper">{note}</p>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs tabular-nums text-muted">
                <div>
                  <dt>Trials</dt>
                  <dd className="text-paper">{trials}</dd>
                </div>
                <div>
                  <dt>Seed</dt>
                  <dd className="text-paper">{scenario ? scenario.seed : "—"}</dd>
                </div>
                <div>
                  <dt>Shrink passes</dt>
                  <dd className="text-paper">{shrinkRuns}</dd>
                </div>
                <div>
                  <dt>Opening run</dt>
                  <dd className="text-paper">{beforeEvents}</dd>
                </div>
                <div>
                  <dt>Shrunk run</dt>
                  <dd className="text-paper">{outcome.events}</dd>
                </div>
              </dl>
              <button
                type="button"
                onClick={() => void copyLink()}
                className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm text-amber"
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Link copied" : "Copy replay link"}
              </button>
            </div>
          ) : null}

          {phase === "clean" ? (
            <div className="mt-5 rounded-card border border-olive bg-panel p-3">
              <p className="inline-flex items-center gap-2 text-sm text-olive">
                <Shield className="size-4" aria-hidden />
                {note}
              </p>
            </div>
          ) : null}

          {frame && mode === "hunt" ? (
            <ul className="mt-5 space-y-2 text-xs">
              {frame.nodes.map((node, index) => (
                <li key={index} className="flex min-w-0 items-center justify-between gap-2 border-b border-line py-2">
                  <span className="shrink-0 text-paper">
                    n{index} {node.alive ? node.role : "down"}
                  </span>
                  <span className="truncate tabular-nums text-muted">
                    t{node.term} c{node.commit} {node.memo}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <p className="mt-6 text-xs leading-relaxed text-muted">
            {mode === "live"
              ? "Live mode does not step the simulator. The connector starts a disposable service, injects crashes and partitions, and checks the replies. Same schedule, same hash."
              : "Same seed, same hash, in this tab. Client replies are instant; inter-node messages take keyed latency and die if the sender crashes. Figures on screen are from this run."}
          </p>
        </aside>
      </div>
    </main>
  );
}

function RaceCard({ label, trials, found }: { label: string; trials: number; found: boolean }) {
  return (
    <div className="rounded-card border border-line bg-panel p-4">
      <p className="text-xs uppercase tracking-widest text-muted">{label}</p>
      <p className="mt-2 font-display text-4xl italic tabular-nums text-paper">{trials}</p>
      <p className={found ? "text-sm text-oxide" : "text-sm text-muted"}>{found ? "Violation" : "Still searching"}</p>
    </div>
  );
}
