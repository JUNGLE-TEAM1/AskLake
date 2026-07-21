import assert from "node:assert/strict";
import test from "node:test";

import { validatePhase7ApprovalBinding } from "./verify-eks-day18-phase7-approval.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function fixture() {
  return {
    contract: {
      approval: { state: "approved" },
      images: { candidate: { gitRevision: "1".repeat(40), receiptSha256: HASH_A } },
      liveInputEvidence: { inputSha256: HASH_B, targetSelectionSha256: HASH_C },
      actions: { rollingUpdate: true, rollback: true },
    },
    candidateReceipt: { gitRevision: "1".repeat(40), platform: "linux/amd64" },
    candidateReceiptSha256: HASH_A,
    liveInputSha256: HASH_B,
    targetSelectionSha256: HASH_C,
    ec2EnvSha256: "d".repeat(64),
    exportedCluster: "asklake-dev",
  };
}

test("accepts an approved Phase 7 binding", () => {
  assert.deepEqual(validatePhase7ApprovalBinding(fixture()), []);
});

test("fails closed when approval, receipt, live input, or actions drift", () => {
  const input = fixture();
  input.contract.approval.state = "pending";
  input.candidateReceiptSha256 = "e".repeat(64);
  input.liveInputSha256 = "f".repeat(64);
  input.contract.actions.rollback = false;
  const errors = validatePhase7ApprovalBinding(input);
  assert.ok(errors.some((error) => error.includes("not approved")));
  assert.ok(errors.some((error) => error.includes("candidate receipt")));
  assert.ok(errors.some((error) => error.includes("live input")));
  assert.ok(errors.some((error) => error.includes("round trip")));
});
