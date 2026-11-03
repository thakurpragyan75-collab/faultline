/** Public surface of the in-browser engine. */

export { bugInfo, ZOO } from "./bugs.ts";
export type { BugInfo } from "./bugs.ts";
export { checkLinear, checkSafety, fold } from "./check.ts";
export { keyed } from "./keyed.ts";
export { candidates, decodeReplay, encodeReplay, randomScenario, shrinkScenario, targeted } from "./scenarios.ts";
export type { BugId, Fault, Frame, Outcome, Scenario, Violation, WorkItem } from "./types.ts";
export { runScenario } from "./world.ts";
export {
  decodeExperiment,
  encodeExperiment,
  raftExperiment,
  registerExperiment,
  runExperiment,
  shrinkExperiment,
} from "./live/runner.ts";
export type { Experiment, LiveReport, TargetId } from "./live/types.ts";

import type { BugId, Outcome } from "./types.ts";
import { bugInfo } from "./bugs.ts";

/** Plain-English cause that cites the trace event and virtual time. */
export function narrate(bug: BugId, outcome: Outcome): string {
  const info = bugInfo(bug);
  if (!outcome.violation) {
    return "No violation. " + outcome.events + " events, hash " + outcome.hash.toString(16) + ".";
  }
  const v = outcome.violation;
  return (
    v.detail +
    " Cited from event " +
    v.event +
    " at " +
    v.time +
    "µs. " +
    info.defect +
    " Hash " +
    outcome.hash.toString(16) +
    "."
  );
}
