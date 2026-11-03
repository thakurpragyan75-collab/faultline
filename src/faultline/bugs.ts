/** Bug zoo catalog. Definitions live here because blueprint sections 6–8 were not in the source file. */

import type { BugId } from "./types.ts";

export type BugInfo = {
  id: BugId;
  name: string;
  tier: string;
  summary: string;
  defect: string;
};

/** The eight safety faults the hunter is built to find, plus the correct system. */
export const ZOO: BugInfo[] = [
  {
    id: "correct",
    name: "Correct Raft",
    tier: "control",
    summary: "Quorum commit, persisted log, one vote per term, read index.",
    defect: "No injected defect. A violation here is a false positive.",
  },
  {
    id: "B01",
    name: "Optimistic match",
    tier: "P0",
    summary: "Leader marks every peer caught up the moment it appends.",
    defect: "matchIndex is forged, so the quorum check commits a write nobody else has.",
  },
  {
    id: "B02",
    name: "Blind vote",
    tier: "P0",
    summary: "A follower grants a vote without checking the candidate's log.",
    defect: "A stale node can win an election and serve a history that dropped a committed write.",
  },
  {
    id: "B03",
    name: "Self quorum",
    tier: "P0",
    summary: "The leader treats itself as a majority.",
    defect: "Commit advances before any follower stores the entry. A crash then loses an acked write.",
  },
  {
    id: "B04",
    name: "Double vote",
    tier: "P0",
    summary: "A node may vote for two candidates in the same term.",
    defect: "Two leaders in one term both believe they hold a quorum.",
  },
  {
    id: "B05",
    name: "Amnesia",
    tier: "P0",
    summary: "Restart drops the log, the term, and the vote.",
    defect: "Power returns with an empty disk, so a committed write is gone after failover.",
  },
  {
    id: "B06",
    name: "Stale read",
    tier: "P0",
    summary: "The leader answers reads from local memory, with no quorum check.",
    defect: "An isolated former leader still serves gets after a new leader has committed a later write.",
  },
  {
    id: "B07",
    name: "Skip odd entries",
    tier: "P0",
    summary: "The state machine applies even log indexes and skips odd ones.",
    defect: "A committed command never reaches the key-value map, but the log still claims it.",
  },
  {
    id: "B11",
    name: "Retry applies twice",
    tier: "P0",
    summary: "Client sequence numbers are not deduplicated.",
    defect: "A fast retry appends the same add again. The counter moves by two.",
  },
];

/** Lookup a catalog row. */
export function bugInfo(id: BugId): BugInfo {
  for (let i = 0; i < ZOO.length; i++) {
    const row = ZOO[i];
    if (row && row.id === id) return row;
  }
  return ZOO[0] as BugInfo;
}
