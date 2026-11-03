/** Black-box checks. These read observations, not the service's source. */

import { checkLinear } from "../check.ts";
import type { Violation } from "../types.ts";
import type { Observation, Status } from "./types.ts";

/** Dual leaders or divergent committed entries, from scraped status pages. */
export function statusAlarm(sample: Status[]): string | null {
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      const a = sample[i];
      const b = sample[j];
      if (!a || !b) continue;
      if (a.alive && b.alive && a.role === "leader" && b.role === "leader" && a.term === b.term && a.term > 0) {
        return "Processes " + a.id + " and " + b.id + " both report leader in term " + a.term + ".";
      }
    }
  }
  let max = 0;
  for (let i = 0; i < sample.length; i++) {
    const node = sample[i];
    if (node && node.commit > max) max = node.commit;
  }
  for (let index = 1; index <= max; index++) {
    let seen: string | null = null;
    let seenId = -1;
    for (let i = 0; i < sample.length; i++) {
      const node = sample[i];
      if (!node || node.commit < index) continue;
      const label = node.entries[index - 1] ?? "missing";
      if (seen === null) {
        seen = label;
        seenId = node.id;
        continue;
      }
      if (seen !== label) {
        return (
          "Committed index " + index + " is " + seen + " on n" + seenId + " and " + label + " on n" + node.id + "."
        );
      }
    }
  }
  return null;
}

/**
 * Client-visible linearizability first, then status alarms.
 * A timeout is an uncertain reply: a write may or may not have taken effect.
 */
export function verifyObservation(obs: Observation, time: number): Violation | null {
  const linear = checkLinear(obs.history, time, obs.history.length);
  if (linear) return linear;
  for (let i = 0; i < obs.samples.length; i++) {
    const sample = obs.samples[i];
    if (!sample) continue;
    const alarm = statusAlarm(sample);
    if (!alarm) continue;
    return {
      kind: alarm.startsWith("Processes") ? "dual-leader" : "divergent-commit",
      time,
      event: obs.history.length,
      detail: alarm,
    };
  }
  return null;
}
