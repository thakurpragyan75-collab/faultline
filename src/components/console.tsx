import { useEffect, useRef, useState } from "react";
import { Activity, Check, Copy, Pause, Play, Shield } from "lucide-react";
import { Crust } from "@/components/crust";
import { driveExternal } from "@/faultline/live/external-drive.ts";
import {
  ZOO,
  bugInfo,
  candidates,
  decodeExperiment,
  decodeReplay,
  encodeExperiment,
  encodeReplay,
  externalExperiment,
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

/** Seismograph, in-page services, and a separate disk process. */
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
  const [trouble, setTrouble] = useState("");
  const run = useRef(0);
  const info = bugInfo(bug);
  const frames: Frame[] = outcome?.frames ?? [];

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const liveToken = params.get("e");
    if (liveToken) {
      const experiment = decodeExperiment(liveToken);
      if (experiment) {
        setMode("live");
        setTarget(experiment.target);
        setBug(experiment.bug);
        if (experiment.target === "external-kv") {
          setPhase("hunting");
          void driveExternal({ data: { experiment } })
            .then((report) => {
              setLive(report);
              setNote(report.violation ? report.violation.detail : "The file survived the crash.");
              setPhase(report.violation ? "found" : "clean");
            })
            .catch((err: unknown) => {
              setTrouble(err instanceof Error ? err.message : "The disk process did not answer.");
              setPhase("idle");
            });
          return;
        }
        const report = runExperiment(experiment);
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
    setTrouble("");
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
    setTrouble("");
    setPlaying(false);
    await wait();
    if (run.current !== id) return;
    if (which === "external-kv") {
      const experiment = externalExperiment(next);
      try {
        const report = await driveExternal({ data: { experiment } });
        if (run.current !== id) return;
        setLive(report);
        setNote(
          report.violation
            ? report.violation.detail
            : next !== "B05" && next !== "correct"
              ? "This disk process fsyncs before it answers. The crash did not lose the write. Pick Amnesia to see the defective build."
              : "The file on disk matched the reply. Hash " + report.hash.toString(16) + ".",
        );
        setPhase(report.violation ? "found" : "clean");
        const url = new URL(window.location.href);
        url.searchParams.delete("r");
        url.searchParams.set("e", encodeExperiment(experiment));
        window.history.replaceState(null, "", url);
      } catch (err) {
        if (run.current !== id) return;
        setTrouble(err instanceof Error ? err.message : "The disk process did not answer.");
        setPhase("idle");
      }
      return;
    }
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
          ? target === "external-kv"
            ? "Talking to the separate disk process."
            : "Driving the connected service."
          : "Trial " + trials + " of " + budget + "."
      : phase === "found"
        ? "Violation held still."
        : phase === "clean"
          ? "Nothing broke."
          : mode === "live"
            ? "Choose a service, then run it."
            : "Pick a fault and run the hunt.";

  const actionClass =
    "inline-flex min-h-12 items-center gap-2 rounded-card bg-oxide px-5 text-base font-medium text-white disabled:opacity-60";

  return (
    <main className="min-h-dvh overflow-x-hidden bg-paper text-ink">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex w-full max-w-[2400px] flex-wrap items-end justify-between gap-6 px-4 py-5 sm:px-6 lg:px-10 2xl:px-16">
          <div className="max-w-3xl">
            <p className="font-display text-5xl leading-none text-ink 2xl:text-6xl">Faultline</p>
            <p className="mt-3 text-lg leading-snug text-ink">
              Pick a fault. Run it. Read what broke. The picture and the result stay on one screen.
            </p>
          </div>
          <div className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:grid-cols-3">
            <ModeButton active={mode === "hunt"} onClick={() => setMode("hunt")} title="Hunt" hint="Simulated cluster" />
            <ModeButton active={mode === "race"} onClick={() => setMode("race")} title="Race" hint="Guided vs random" />
            <ModeButton active={mode === "live"} onClick={() => setMode("live")} title="Live" hint="A real process" />
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[2400px] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[20rem_minmax(0,1fr)_26rem] lg:px-10 2xl:grid-cols-[24rem_minmax(0,1fr)_32rem] 2xl:px-16">
        <section className="rounded-card border border-line bg-panel p-4">
          <h2 className="text-base font-medium text-ink">What to test</h2>
          <p className="mt-1 text-base text-muted">One fault at a time. Correct is the control.</p>
          <ul className="mt-4 flex max-w-full gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
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
                      "flex min-h-14 w-full flex-col items-start rounded-card border px-3 py-2 text-left " +
                      (selected ? "border-oxide bg-panel-2" : "border-line bg-panel")
                    }
                  >
                    <span className="text-sm text-amber">{row.id === "correct" ? "Control" : row.id}</span>
                    <span className="text-base text-ink">{row.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="min-w-0 rounded-card border border-line bg-panel">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
            <p className="text-lg font-medium text-ink">{status}</p>
            <div className="flex gap-2">
              {mode === "hunt" ? (
                <button type="button" onClick={() => void hunt(bug)} disabled={phase === "hunting"} className={actionClass}>
                  <Play className="size-4" aria-hidden />
                  {bug === "correct" ? "Spot-check soundness" : "Hunt this fault"}
                </button>
              ) : mode === "race" ? (
                <button
                  type="button"
                  onClick={() => void startRace(bug)}
                  disabled={phase === "hunting" || bug === "correct"}
                  className={actionClass}
                >
                  <Activity className="size-4" aria-hidden />
                  Race random vs guided
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void runLive(bug, target)}
                  disabled={phase === "hunting"}
                  className={actionClass}
                >
                  <Activity className="size-4" aria-hidden />
                  Run on the live service
                </button>
              )}
            </div>
          </div>

          {mode === "live" ? (
            <div className="px-4 py-4 sm:px-5">
              <div className="mb-4 flex flex-wrap gap-2">
                <TargetButton
                  active={target === "raft-service"}
                  onClick={() => setTarget("raft-service")}
                  label="Raft service"
                />
                <TargetButton
                  active={target === "register-service"}
                  onClick={() => setTarget("register-service")}
                  label="Register service"
                />
                <TargetButton
                  active={target === "external-kv"}
                  onClick={() => setTarget("external-kv")}
                  label="External disk"
                />
              </div>
              <p className="mb-4 text-base leading-relaxed text-ink">
                {target === "raft-service"
                  ? "Three Raft processes inside this page. Faultline reads only their replies and status pages."
                  : target === "register-service"
                    ? "A register inside this page. Amnesia answers before the write reaches its disk model."
                    : "A separate program Faultline did not write. It keeps a real file. Faultline crashes that process and then reads the file and the new process's replies."}
              </p>
              <ol className="max-h-96 space-y-2 overflow-y-auto text-base leading-relaxed text-ink">
                {(live?.notes ?? ["Nothing has run yet."]).map((line, index) => (
                  <li
                    key={index + line}
                    className={
                      line.includes("→ empty") || line.includes("killed") || line.includes("acked before")
                        ? "text-oxide"
                        : undefined
                    }
                  >
                    {line}
                  </li>
                ))}
              </ol>
            </div>
          ) : mode === "race" && race ? (
            <div className="grid gap-3 px-4 py-4 sm:grid-cols-2 sm:px-5">
              <RaceCard label="Guided" trials={race.guided} found={race.guidedFound} />
              <RaceCard label="Random" trials={race.random} found={race.randomFound} />
              <p className="text-base text-muted sm:col-span-2">
                {race.done
                  ? "Counts are this run only. Guided tries aimed fault schedules first."
                  : "Both searches share the same engine. Neither number is a published benchmark."}
              </p>
            </div>
          ) : (
            <>
              <Crust frames={frames} index={frames.length === 0 ? 0 : play} />
              <div className="flex min-w-0 items-center gap-3 px-4 py-4 sm:px-5">
                <button
                  type="button"
                  aria-label={playing ? "Pause replay" : "Play replay"}
                  disabled={frames.length === 0}
                  onClick={() => setPlaying((v) => !v)}
                  className="inline-flex size-12 shrink-0 items-center justify-center rounded-card border border-line bg-panel text-ink disabled:opacity-40"
                >
                  {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
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
                <span className="w-20 shrink-0 text-right text-base tabular-nums text-muted">
                  {frame ? Math.floor(frame.time / 1000) + " ms" : "—"}
                </span>
              </div>
              <ol className="max-h-48 space-y-1 overflow-y-auto px-4 pb-4 text-base text-ink sm:px-5">
                {frames.slice(Math.max(0, play - 5), play + 1).map((item) => (
                  <li key={item.i + "-" + item.label} className={item.tone === "bad" ? "text-oxide" : undefined}>
                    {item.i} · {item.label}
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>

        <aside className="rounded-card border border-line bg-panel p-5">
          <p className="text-sm font-medium text-amber">{info.id === "correct" ? "Control" : info.id}</p>
          <h1 className="font-display mt-1 text-4xl text-ink 2xl:text-5xl">{info.name}</h1>
          <p className="mt-4 text-lg leading-relaxed text-ink">{info.summary}</p>
          <p className="mt-3 text-base leading-relaxed text-muted">{info.defect}</p>

          {trouble ? (
            <div className="mt-5 rounded-card border border-oxide bg-panel-2 p-4">
              <p className="text-base leading-relaxed text-oxide">{trouble}</p>
            </div>
          ) : null}

          {phase === "found" && live?.violation && mode === "live" ? (
            <div className="mt-5 rounded-card border border-oxide bg-panel-2 p-4">
              <p className="text-sm font-medium uppercase text-oxide">{live.violation.kind}</p>
              <p className="mt-2 text-lg leading-relaxed text-ink">{note}</p>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-base tabular-nums">
                <div>
                  <dt className="text-muted">Steps</dt>
                  <dd className="text-ink">{live.events}</dd>
                </div>
                <div>
                  <dt className="text-muted">Calls</dt>
                  <dd className="text-ink">{live.history.length}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-muted">Hash</dt>
                  <dd className="break-all text-ink">{live.hash.toString(16)}</dd>
                </div>
              </dl>
              <button type="button" onClick={() => void copyLink()} className="mt-4 inline-flex min-h-12 items-center gap-2 text-base text-amber">
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Link copied" : "Copy replay link"}
              </button>
            </div>
          ) : null}

          {phase === "found" && outcome?.violation && mode === "hunt" ? (
            <div className="mt-5 rounded-card border border-oxide bg-panel-2 p-4">
              <p className="text-sm font-medium uppercase text-oxide">{outcome.violation.kind}</p>
              <p className="mt-2 text-lg leading-relaxed text-ink">{note}</p>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-base tabular-nums">
                <div>
                  <dt className="text-muted">Trials</dt>
                  <dd>{trials}</dd>
                </div>
                <div>
                  <dt className="text-muted">Seed</dt>
                  <dd>{scenario ? scenario.seed : "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted">Shrink passes</dt>
                  <dd>{shrinkRuns}</dd>
                </div>
                <div>
                  <dt className="text-muted">Opening run</dt>
                  <dd>{beforeEvents}</dd>
                </div>
                <div>
                  <dt className="text-muted">Events now</dt>
                  <dd>{outcome.events}</dd>
                </div>
              </dl>
              <button type="button" onClick={() => void copyLink()} className="mt-4 inline-flex min-h-12 items-center gap-2 text-base text-amber">
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Link copied" : "Copy replay link"}
              </button>
            </div>
          ) : null}

          {phase === "clean" ? (
            <div className="mt-5 rounded-card border border-olive bg-panel-2 p-4">
              <p className="inline-flex items-start gap-2 text-base leading-relaxed text-olive">
                <Shield className="mt-1 size-4 shrink-0" aria-hidden />
                {note}
              </p>
            </div>
          ) : null}

          {frame && mode === "hunt" ? (
            <ul className="mt-5 space-y-2 text-base">
              {frame.nodes.map((node, index) => (
                <li key={index} className="flex min-w-0 items-center justify-between gap-3 border-b border-line py-2">
                  <span className="shrink-0 text-ink">
                    n{index} {node.alive ? node.role : "down"}
                  </span>
                  <span className="truncate tabular-nums text-muted">
                    t{node.term} c{node.commit} {node.memo}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <p className="mt-6 text-base leading-relaxed text-muted">
            {mode === "live"
              ? target === "external-kv"
                ? "External disk does not use the simulator. Replay runs the same calls against whatever process is listening, so the result matches only while that program is the same build."
                : "Raft and the register on this tab still run inside the page. They are reference services, not somebody else's database."
              : "Same seed, same hash, in this tab. The picture is from this run."}
          </p>
        </aside>
      </div>
    </main>
  );
}

function ModeButton({ active, onClick, title, hint }: { active: boolean; onClick: () => void; title: string; hint: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "min-h-14 rounded-card border px-4 py-2 text-left " +
        (active ? "border-oxide bg-panel-2 text-ink" : "border-line bg-paper text-muted")
      }
    >
      <span className="block text-base font-medium text-ink">{title}</span>
      <span className="block text-sm text-muted">{hint}</span>
    </button>
  );
}

function TargetButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "min-h-12 rounded-card border px-4 text-base " +
        (active ? "border-oxide bg-panel-2 text-ink" : "border-line bg-paper text-muted")
      }
    >
      {label}
    </button>
  );
}

function RaceCard({ label, trials, found }: { label: string; trials: number; found: boolean }) {
  return (
    <div className="rounded-card border border-line bg-paper p-4">
      <p className="text-base text-muted">{label}</p>
      <p className="mt-2 font-display text-5xl tabular-nums text-ink">{trials}</p>
      <p className={found ? "text-base text-oxide" : "text-base text-muted"}>{found ? "Violation" : "Still searching"}</p>
    </div>
  );
}