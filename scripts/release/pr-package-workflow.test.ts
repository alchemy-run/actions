import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Step = {
  id?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};
type Job = {
  needs?: string[];
  if?: string;
  outputs?: Record<string, string>;
  steps: Step[];
};

const workflowPath = join(
  import.meta.dir,
  "../../.github/workflows/pr-package.yml",
);
const workflow = Bun.YAML.parse(readFileSync(workflowPath, "utf8")) as {
  jobs: Record<string, Job>;
};

describe("pr-package workflow", () => {
  test("checks out submodules before detecting changes and planning", () => {
    for (const jobName of ["detect-changes", "plan"]) {
      const checkout = workflow.jobs[jobName]!.steps.find(
        (step) => step.uses?.startsWith("actions/checkout@") && !step.with?.repository,
      );
      expect(checkout?.with?.submodules).toBe("${{ inputs.submodules }}");
    }
  });

  test("plans and gates all five publication waves", () => {
    const plan = workflow.jobs.plan!;
    const waveStep = plan.steps.find((step) => step.id === "waves");

    expect(Object.keys(plan.outputs ?? {}).filter((key) => key.startsWith("wave"))).toEqual([
      "wave1",
      "wave2",
      "wave3",
      "wave4",
      "wave5",
    ]);
    expect(waveStep?.env?.ALCHEMY_MAX_WAVES).toBe("5");

    for (let wave = 2; wave <= 5; wave++) {
      const job = workflow.jobs[`publish-wave-${wave}`]!;
      for (let dependency = 1; dependency < wave; dependency++) {
        expect(job.needs).toContain(`publish-wave-${dependency}`);
        expect(job.if).toContain(`needs.publish-wave-${dependency}.result == 'success'`);
      }
    }
  });

  test("does not advertise install URLs after a partial publication", () => {
    const comment = workflow.jobs.comment!;

    for (let wave = 1; wave <= 5; wave++) {
      expect(comment.needs).toContain(`publish-wave-${wave}`);
      expect(comment.if).toContain(`needs.publish-wave-${wave}.result == 'success'`);
    }
  });
});
