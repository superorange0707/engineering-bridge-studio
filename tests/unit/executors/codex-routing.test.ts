import assert from "node:assert/strict";
import test from "node:test";

import { routeCodexTask, routingTransition } from "../../../src/executors/codex-routing.js";

test("auto routing is quality-first and defaults uncertain work to local_lead", () => {
  assert.deepEqual(routeCodexTask("auto", "Investigate why this behavior is odd"), {
    requestedRouting: "auto",
    logicalRole: "local_lead",
    reason: "default_quality_route",
    matchedRule: "quality_fallback",
    matchedFactors: [],
    ignoredGuardFactors: []
  });
  assert.equal(routeCodexTask("auto", "Investigate this ambiguous behavior.").logicalRole, "local_lead");
});

test("auto routing selects implementer only for both a clear action and bounded scope", () => {
  assert.equal(routeCodexTask("auto", "Fix the one failing parser test").logicalRole, "implementer");
  assert.equal(routeCodexTask("auto", "Fix the system").logicalRole, "local_lead");
});

test("auto routing prioritizes high-risk and architectural signals", () => {
  assert.equal(routeCodexTask("auto", "Fix one critical security migration test").logicalRole, "repo_principal");
  assert.equal(routeCodexTask("auto", "审查这个高风险架构迁移").logicalRole, "repo_principal");
  assert.equal(routeCodexTask("auto", "Migrate the production data/schema to the new format.").logicalRole,
    "repo_principal");
  assert.equal(routeCodexTask("auto", "Design the migration and compatibility architecture.").logicalRole,
    "repo_principal");
  assert.equal(routeCodexTask("auto", "Plan the production schema migration.").logicalRole, "repo_principal");
  assert.equal(routeCodexTask("auto", "Propose a new authorization architecture.").logicalRole, "repo_principal");
  assert.equal(routeCodexTask("auto", "Evaluate the migration and compatibility strategy.").logicalRole,
    "repo_principal");
  assert.equal(routeCodexTask(
    "auto", "Investigate this ambiguous behavior, but assess the security architecture."
  ).logicalRole, "repo_principal");
});

test("negative and fail-closed guards do not turn bounded documentation into principal work", () => {
  const selection = routeCodexTask("auto", [
    "Add a Testing section to one README.",
    "If evidence is ambiguous fail closed.",
    "Do not change migrations or runtime behavior."
  ].join(" "));

  assert.equal(selection.logicalRole, "implementer");
  assert.equal(selection.matchedRule, "bounded_implementation");
  assert.ok(selection.matchedFactors.includes("action:add"));
  assert.ok(selection.matchedFactors.includes("scope:one"));
  assert.deepEqual(selection.ignoredGuardFactors, ["signal:migrations"]);

  const embedded = routeCodexTask(
    "auto",
    "Document one specific README file without changing permissions or security boundaries."
  );
  assert.equal(embedded.logicalRole, "implementer");
  assert.deepEqual([...embedded.ignoredGuardFactors].sort(), ["signal:permissions", "signal:security"]);

  const inline = routeCodexTask(
    "auto",
    "Add one README Testing section and do not change migration behavior."
  );
  assert.equal(inline.logicalRole, "implementer");
  assert.deepEqual(inline.ignoredGuardFactors, ["signal:migration"]);

  const reset = routeCodexTask(
    "auto",
    "Do not change permissions, but redesign the compatibility architecture."
  );
  assert.equal(reset.logicalRole, "repo_principal");
  assert.ok(reset.matchedFactors.includes("signal:architecture"));

  const prefix = routeCodexTask(
    "auto",
    "Without changing permissions, redesign the compatibility architecture."
  );
  assert.equal(prefix.logicalRole, "repo_principal");
  assert.ok(prefix.matchedFactors.includes("signal:architecture"));
});

test("conditional guards remain guarded across internal comma punctuation", () => {
  assert.equal(routeCodexTask(
    "auto", "Add one README line. If a security change is required, fail closed."
  ).logicalRole, "implementer");
  assert.equal(routeCodexTask(
    "auto", "Add one README line. If permissions must change, stop."
  ).logicalRole, "implementer");
  assert.equal(routeCodexTask(
    "auto", "Add one README line. If a schema migration is required, reject the task."
  ).logicalRole, "implementer");
  assert.equal(routeCodexTask(
    "auto", "If migration is required, design and execute the migration."
  ).logicalRole, "repo_principal");
});

test("conditional outcomes survive reset words without hiding consequential work", () => {
  assert.equal(routeCodexTask("auto", [
    "If we must change security but evidence is ambiguous, fail closed.",
    "Add one README line."
  ].join("\n")).logicalRole, "implementer");
  assert.equal(routeCodexTask("auto", [
    "Add one README line.",
    "If permissions must change but evidence is unclear, stop."
  ].join("\n")).logicalRole, "implementer");
  assert.equal(routeCodexTask(
    "auto", "If a migration is needed, assess it and stop before applying changes."
  ).logicalRole, "repo_principal");
  assert.equal(routeCodexTask(
    "auto", "If needed, assess the security architecture, then stop before applying changes."
  ).logicalRole, "repo_principal");
  assert.equal(routeCodexTask(
    "auto", "If evidence is ambiguous, fail closed."
  ).logicalRole, "local_lead");
  assert.equal(routeCodexTask(
    "auto", "If migration is required, reject the task."
  ).logicalRole, "local_lead");
  assert.equal(routeCodexTask(
    "auto", "Do not change permissions, but redesign the compatibility architecture."
  ).logicalRole, "repo_principal");
  assert.equal(routeCodexTask(
    "auto", "Document one README file without changing permissions."
  ).logicalRole, "implementer");
});

test("adjacent positive comma clauses retain high-risk subject and action association", () => {
  assert.equal(routeCodexTask(
    "auto", "For the production schema migration, plan the rollout."
  ).logicalRole, "repo_principal");
  assert.equal(routeCodexTask(
    "auto", "Regarding permissions, redesign the access model."
  ).logicalRole, "repo_principal");
  assert.equal(routeCodexTask(
    "auto", "For the security architecture, assess the impact."
  ).logicalRole, "repo_principal");
  assert.equal(routeCodexTask(
    "auto", "Add one README line, documenting the schema field name."
  ).logicalRole, "implementer");
  assert.equal(routeCodexTask(
    "auto", "Add one README line, do not change the schema."
  ).logicalRole, "implementer");
  assert.equal(routeCodexTask(
    "auto", "Do not change permissions, redesign the compatibility architecture."
  ).logicalRole, "repo_principal");
});

test("bounded documentation about a high-risk topic is not a high-risk action", () => {
  for (const instruction of [
    "Fix one typo in the security README.",
    "Change one line documenting the schema field name.",
    "Review one security typo in README.",
    "Add one README note about a critical error."
  ]) {
    assert.equal(routeCodexTask("auto", instruction).logicalRole, "implementer", instruction);
  }
  for (const instruction of [
    "Change permissions for one endpoint.",
    "Modify the production authorization policy.",
    "Implement a schema migration.",
    "Investigate a production security incident."
  ]) {
    assert.equal(routeCodexTask("auto", instruction).logicalRole, "repo_principal", instruction);
  }
});

test("guard-only implementation factors do not manufacture bounded implementation", () => {
  assert.equal(routeCodexTask(
    "auto", "Do not change one file. Investigate why this behavior is odd."
  ).logicalRole, "local_lead");
  assert.equal(routeCodexTask(
    "auto", "Add one README Testing section; do not change migrations or runtime behavior."
  ).logicalRole, "implementer");
});

test("ordinary Chinese mode work is bounded implementation, not schema architecture", () => {
  assert.equal(routeCodexTask("auto", "修改深色模式的一行文案").logicalRole, "implementer");
  assert.equal(routeCodexTask("auto", "规划生产数据库模式迁移").logicalRole, "repo_principal");
});

test("explicit logical-role overrides bypass classification without exposing model or effort", () => {
  assert.deepEqual(routeCodexTask("repo_principal", "Rename one field"), {
    requestedRouting: "repo_principal",
    logicalRole: "repo_principal",
    reason: "explicit_override",
    matchedRule: "explicit_override",
    matchedFactors: ["override:repo_principal"],
    ignoredGuardFactors: []
  });
});

test("role changes are classified as escalation, de-escalation, or same-tier handoff", () => {
  assert.equal(routingTransition("implementer", "repo_principal"), "escalation");
  assert.equal(routingTransition("repo_principal", "implementer"), "de_escalation");
  assert.equal(routingTransition("local_lead", "local_lead"), "handoff");
});
