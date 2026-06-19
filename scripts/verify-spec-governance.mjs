import { readFileSync } from "node:fs";

const files = {
  skill: readFileSync("skills/spec/SKILL.md", "utf8"),
  matrix: readFileSync("skills/spec/matrix.md", "utf8"),
  registry: readFileSync("skills/spec/registry.yaml", "utf8"),
  template: readFileSync("skills/spec/spec-template.md", "utf8"),
};

const checks = [
  {
    name: "N4 exit gate requires transcript-verifiable unconditionally",
    pass:
      /done_criteria_requirement:\s*transcript_verifiable/.test(files.registry) &&
      /Done标准\(transcript-verifiable\)/.test(files.registry) &&
      !/Done标准\(启用\/goal时须transcript-verifiable\)/.test(files.registry),
  },
  {
    name: "/goal opt-in is asked before N5 after N4, not at Gate 1",
    pass:
      /ask_timing:\s*before_N5_after_N4/.test(files.registry) &&
      !/Gate 1 询问用户是否启用 \/goal/.test(files.registry),
  },
  {
    name: "Gate 1 does not claim to approve the N4-derived /goal condition",
    pass:
      /Gate 1 只展示 N6 的 goal_condition/.test(files.skill) &&
      /\/goal 条件必须在 N5 前从 N4/.test(files.skill),
  },
  {
    name: "N1 exit requires goal_condition synchronization before N3 or N5",
    pass:
      /goal_condition_sync_required:\s*true/.test(files.registry) &&
      /进入 N3 或 N5 前更新 goal_condition/.test(files.skill),
  },
  {
    name: "Empty goal_condition has a refill or explicit waiver path",
    pass:
      /goal_condition_waived:\s*false/.test(files.template) &&
      /goal_condition 为空且未被显式豁免/.test(files.skill),
  },
  {
    name: "N5 reruns structurally invalidate N7 and N6",
    pass:
      /invalidates_on_rerun:\s*\[N7_review,\s*N6_verify\]/.test(files.registry) &&
      /requires_after_last_run:\s*N7_review/.test(files.registry),
  },
  {
    name: "N6 failure path distinguishes implementation rerun from spec/task reopen",
    pass:
      /实现未达标但 spec\/N4 仍有效/.test(files.skill) &&
      /spec 或 N4 任务需要变化/.test(files.skill) &&
      /重新写入 spec_commit/.test(files.skill),
  },
  {
    name: "Flows with N7 run review before final N6 verification",
    pass:
      /N5\s*→\s*N7\s*→\s*N6/.test(files.matrix) &&
      /nodes:\s*\[N1,\s*N3,\s*N4,\s*N5,\s*N7,\s*N6\]/.test(files.template) &&
      !/N5\s*→\s*N6\s*→\s*N7/.test(files.matrix),
  },
  {
    name: "Resume preserves existing goal_condition_waived front-matter",
    pass:
      /新建 spec 时[^\n]*goal_condition_waived:\s*false/.test(files.skill) &&
      /续跑[^\n]*保留已有[^\n]*goal_condition_waived/.test(files.skill),
  },
  {
    name: "N5 skips /goal opt-in when no usable condition source exists",
    pass:
      /条件来源为空或已被显式豁免/.test(files.skill) &&
      /跳过 `\/goal` 启用询问/.test(files.skill),
  },
];

let failed = 0;

for (const check of checks) {
  if (check.pass) {
    console.log(`PASS ${check.name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${check.name}`);
  }
}

if (failed > 0) {
  process.exit(1);
}
