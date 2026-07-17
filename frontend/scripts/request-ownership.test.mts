import assert from "node:assert/strict";
import test from "node:test";

import {
  createMutationLifecycle,
  createResourceQueryKey,
  LatestRequestGate,
  MutationRevisionGate,
  transitionMutation,
} from "../src/state/requestOwnership.ts";

test("resource query key includes resource, session, version and stable params", () => {
  const first = createResourceQueryKey({ resource: "jobs", sessionId: "session-1", version: 3, params: { status: "running", owner: "data-team" } });
  const second = createResourceQueryKey({ resource: "jobs", sessionId: "session-1", version: 3, params: { owner: "data-team", status: "running" } });
  assert.equal(first, second);
  assert.notEqual(first, createResourceQueryKey({ resource: "jobs", sessionId: "session-2", version: 3, params: { owner: "data-team", status: "running" } }));
});

test("latest request gate aborts and rejects stale completions", () => {
  const gate = new LatestRequestGate();
  const first = gate.begin(createResourceQueryKey({ resource: "catalog", version: 1 }));
  const second = gate.begin(createResourceQueryKey({ resource: "catalog", version: 2 }));
  assert.equal(first.signal.aborted, true);
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  assert.equal(gate.complete(second), true);
});

test("mutation lifecycle keeps one revision across accepted and reconciled states", () => {
  const pending = transitionMutation(createMutationLifecycle(), "pending");
  const accepted = transitionMutation(pending, "accepted");
  const reconciled = transitionMutation(accepted, "reconciled");
  assert.deepEqual([pending.phase, accepted.phase, reconciled.phase], ["pending", "accepted", "reconciled"]);
  assert.equal(reconciled.revision, 1);
  assert.equal(transitionMutation(pending, "failed", "network").error, "network");
});

test("mutation rollback ownership rejects an older entity revision", () => {
  const gate = new MutationRevisionGate();
  const first = gate.begin("job-1");
  const second = gate.begin("job-1");
  const otherJob = gate.begin("job-2");

  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  assert.equal(gate.isCurrent(otherJob), true);

  gate.invalidate("job-1");
  assert.equal(gate.isCurrent(second), false);
});
