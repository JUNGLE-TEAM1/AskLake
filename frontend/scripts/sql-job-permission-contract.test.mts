import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const creationHook = readFileSync(new URL("../src/pages/sql/useSqlJobCreation.ts", import.meta.url), "utf8");
const draftState = readFileSync(new URL("../src/state/asklake/sqlJobDraft.ts", import.meta.url), "utf8");

test("SQL Job requests forward the selected principal to both creation APIs", () => {
  assert.equal(
    creationHook.match(/principalId:\s*configuration\.governance\.principalId\.trim\(\)\s*\|\|\s*undefined/g)?.length,
    2,
  );
});

test("SQL Job permissions use durable public and group principal metadata", () => {
  assert.match(draftState, /principalId:\s*"authenticated-users"/);
  assert.match(draftState, /principalType:\s*"public"/);
  assert.match(draftState, /principalType:\s*"group"/);
  assert.match(draftState, /if \(accessScope === "private"\) \{\s*return \[\];/);
});

test("SQL Job permissions do not fabricate legacy group names", () => {
  assert.doesNotMatch(draftState, /Data Engineer Group|Data Analyst Group|Project Members/);
});
