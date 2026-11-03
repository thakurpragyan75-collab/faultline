import type { Frame } from "@/faultline/index.ts";

type CrustProps = {
  frames: Frame[];
  index: number;
};

const W = 800;
const H = 420;

function roleClass(alive: boolean, role: string): string {
  if (!alive) return "stroke-line";
  if (role === "leader") return "stroke-oxide";
  if (role === "candidate") return "stroke-amber";
  return "stroke-olive";
}

/** Swimlanes and seismograph, drawn as SVG so the trace stays sharp at any width. */
export function Crust({ frames, index }: CrustProps) {
  const shown = frames.slice(0, Math.max(0, index) + 1);
  const t0 = shown[0]?.time ?? 0;
  const t1 = Math.max((shown[shown.length - 1]?.time ?? 0) + 1, t0 + 1);
  const top = 40;
  const traceTop = 300;
  const laneH = (traceTop - top - 8) / 3;
  const xOf = (t: number) => 64 + ((t - t0) / (t1 - t0)) * (W - 88);
  const yOf = (node: number) => top + node * laneH + laneH / 2;

  const bins = 72;
  const counts: number[] = [];
  for (let i = 0; i < bins; i++) counts.push(0);
  for (let i = 0; i < shown.length; i++) {
    const frame = shown[i];
    if (!frame) continue;
    const b = Math.min(bins - 1, Math.floor(((frame.time - t0) / (t1 - t0)) * (bins - 1)));
    const bump = frame.tone === "bad" ? 8 : frame.tone === "fault" ? 3 : 1;
    counts[b] = (counts[b] ?? 0) + bump;
  }
  let peak = 1;
  for (let i = 0; i < counts.length; i++) if ((counts[i] ?? 0) > peak) peak = counts[i] ?? 1;
  let trace = "";
  for (let i = 0; i < bins; i++) {
    const x = 64 + (i / (bins - 1)) * (W - 88);
    const mag = ((counts[i] ?? 0) / peak) * 42;
    const y = 360 - mag;
    trace += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
  }

  const last = shown[shown.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-80 w-full bg-panel font-sans lg:h-[32rem] 2xl:h-[40rem]" role="img" aria-label="Cluster swimlane and seismograph">
      <rect width={W} height={H} className="fill-panel" />
      <text x="16" y="28" className="fill-muted text-sm">
        nodes
      </text>
      {[0, 1, 2].map((n) => (
        <g key={n}>
          <text x="16" y={yOf(n) + 4} className="fill-ink text-sm">
            n{n}
          </text>
          <line x1="64" x2={W - 16} y1={yOf(n)} y2={yOf(n)} className="stroke-line" strokeWidth="1" />
        </g>
      ))}
      {shown.length === 0 ? (
        <text x="64" y="160" className="fill-muted text-base">
          Waiting for a hunt
        </text>
      ) : null}
      {[0, 1, 2].map((n) => {
        let d = "";
        let prev = xOf(t0);
        const parts: { d: string; cls: string; dash: string }[] = [];
        let cls = "stroke-line";
        let dash = "";
        for (let i = 0; i < shown.length; i++) {
          const frame = shown[i];
          const snap = frame?.nodes[n];
          if (!frame || !snap) continue;
          const x = xOf(frame.time);
          const nextCls = roleClass(snap.alive, snap.role);
          const nextDash = snap.alive ? "" : "3 4";
          if (i === 0) {
            cls = nextCls;
            dash = nextDash;
          }
          if (nextCls !== cls || nextDash !== dash) {
            if (d) parts.push({ d, cls, dash });
            d = `M ${prev} ${yOf(n)} L ${x} ${yOf(n)} `;
            cls = nextCls;
            dash = nextDash;
          } else {
            if (!d) d = `M ${prev} ${yOf(n)} `;
            d += `L ${x} ${yOf(n)} `;
          }
          prev = x;
        }
        if (d) parts.push({ d, cls, dash });
        return parts.map((part, i) => (
          <path
            key={n + "-" + i}
            d={part.d}
            fill="none"
            className={part.cls}
            strokeWidth="2.5"
            strokeDasharray={part.dash || undefined}
          />
        ));
      })}
      {shown.map((frame) => {
        if (frame.tone !== "msg" || frame.from < 0 || frame.to < 0 || frame.from > 2 || frame.to > 2) return null;
        const x = xOf(frame.time);
        const y1 = yOf(frame.from);
        const y2 = yOf(frame.to);
        return (
          <path
            key={"m" + frame.i}
            d={`M ${x} ${y1} Q ${x + 16} ${(y1 + y2) / 2} ${x} ${y2}`}
            fill="none"
            className="stroke-amber"
            strokeWidth="1"
            opacity="0.45"
          />
        );
      })}
      {last ? (
        <line
          x1={xOf(last.time)}
          x2={xOf(last.time)}
          y1="28"
          y2={traceTop - 8}
          className={last.tone === "bad" ? "stroke-oxide" : "stroke-ink"}
          strokeWidth="1"
        />
      ) : null}
      <text x="16" y="332" className="fill-ink text-sm">
        trace
      </text>
      <path d={trace} fill="none" className="stroke-amber" strokeWidth="1.5" />
    </svg>
  );
}
