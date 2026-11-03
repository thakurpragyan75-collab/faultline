/** Browser entry to the separate disk process. The page never opens that port itself. */

import { createServerFn } from "@tanstack/react-start";
import type { Experiment, LiveReport } from "./types.ts";

const PORT = 8091;

export const driveExternal = createServerFn({ method: "POST" })
  .validator((input: { experiment: Experiment }) => {
    if (!input || input.experiment?.target !== "external-kv") {
      throw new Error("This connector only drives the external disk process.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<LiveReport> => {
    const { ensureTarget } = await import("./target-process.ts");
    const { runExternal } = await import("./external.ts");
    const base = await ensureTarget(PORT);
    return runExternal(data.experiment, base);
  });
