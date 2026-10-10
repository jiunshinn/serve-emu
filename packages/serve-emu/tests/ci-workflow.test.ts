import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import packageJson from "../package.json" with { type: "json" };

type Step = { name?: string; id?: string; if?: string; run?: string };
type Job = { steps: Step[] };

const SCRIPT_STEP = /^bun run --filter serve-emu (\S+)$/;

const workflow = Bun.YAML.parse(
  readFileSync(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  ),
) as { jobs: Record<string, Job> };

/** The package scripts a job runs, in order, with the step that runs each. */
function scriptSteps(job: Job): { script: string; step: Step }[] {
  return job.steps.flatMap((step) => {
    const script = step.run?.trim().match(SCRIPT_STEP)?.[1];
    return script ? [{ script, step }] : [];
  });
}

describe("CI workflow", () => {
  const checkScripts = packageJson.scripts.check
    .split("&&")
    .map((command) => command.trim().replace(/^bun run /, ""));

  test("the check job runs every command of `check`, in order, one per step", () => {
    expect(
      scriptSteps(workflow.jobs.check!).map(({ script }) => script),
    ).toEqual(checkScripts);
  });

  test("each check step still runs after an earlier one failed", () => {
    for (const { step } of scriptSteps(workflow.jobs.check!)) {
      expect(step.if).toBe(
        "${{ !cancelled() && steps.install.outcome == 'success' }}",
      );
    }
    expect(
      workflow.jobs.check!.steps.some((step) => step.id === "install"),
    ).toBe(true);
  });

  test("no other job repeats a command of `check`", () => {
    const repeated = Object.entries(workflow.jobs)
      .filter(([name]) => name !== "check")
      .flatMap(([name, job]) =>
        scriptSteps(job)
          .filter(({ script }) =>
            [...checkScripts, "check", "test"].includes(script),
          )
          .map(({ script }) => `${name}: ${script}`),
      );
    expect(repeated).toEqual([]);
  });
});
