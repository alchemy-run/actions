import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
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
const publisherPath = join(
  import.meta.dir,
  "../../actions/pr-package/action.yml",
);
const publisher = Bun.YAML.parse(readFileSync(publisherPath, "utf8")) as {
  runs: { using: string; steps: Step[] };
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

  test("uses the shared publisher action for every wave", () => {
    for (let wave = 1; wave <= 5; wave++) {
      const job = workflow.jobs[`publish-wave-${wave}`]!;
      const publishers = job.steps.filter(
        (step) => step.uses === "./.alchemy-actions/actions/pr-package",
      );

      expect(publishers).toHaveLength(1);
      expect(publishers[0]?.with?.dir).toBe("${{ matrix.package.dir }}");
      expect(publishers[0]?.with?.tag).toBe("${{ needs.plan.outputs.short }}");
    }
  });

  test("the shared publisher retains the complete package flow", () => {
    expect(publisher.runs.using).toBe("composite");
    expect(publisher.runs.steps[0]?.uses).toBe(
      "./.alchemy-actions/actions/setup",
    );
    expect(
      publisher.runs.steps.find((step) => step.name?.startsWith("Build")),
    ).toBeDefined();
    expect(
      publisher.runs.steps.find((step) =>
        step.run?.includes("rewrite-pr-package-deps.ts"),
      ),
    ).toBeDefined();
    expect(
      publisher.runs.steps.find((step) => step.run?.includes("curl -fsSL")),
    ).toBeDefined();
  });

  test("does not advertise install URLs after a partial publication", () => {
    const comment = workflow.jobs.comment!;

    for (let wave = 1; wave <= 5; wave++) {
      expect(comment.needs).toContain(`publish-wave-${wave}`);
      expect(comment.if).toContain(`needs.publish-wave-${wave}.result == 'success'`);
    }
  });
});
