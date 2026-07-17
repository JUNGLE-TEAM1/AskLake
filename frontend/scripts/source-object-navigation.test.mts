import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const modelPath = new URL("../src/pages/etl/sourceModel.tsx", import.meta.url);
const pagePath = new URL("../src/pages/etl/SourceConnectionPage.tsx", import.meta.url);
const connectorServicePath = new URL("../src/services/sourceConnectorService.ts", import.meta.url);
const modelSource = readFileSync(modelPath, "utf8");
const pageSource = readFileSync(pagePath, "utf8");
const connectorServiceSource = readFileSync(connectorServicePath, "utf8");
const sourceFile = ts.createSourceFile(modelPath.pathname, modelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function loadFunction<T extends (...args: any[]) => any>(name: string): T {
  const declaration = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
  ));
  assert.ok(declaration, `${name} must be exported from sourceModel.tsx`);
  const transpiled = ts.transpileModule(declaration.getText(sourceFile), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/^export\s+/m, "");
  return Function(`${transpiled}\nreturn ${name};`)() as T;
}

const resolveSourcePathNavigation = loadFunction<(
  path: string,
  assets: Array<[string, string, string]>,
) => { kind: string; path: string; }>("resolveSourcePathNavigation");
const buildSourceObjectSelectionFields = loadFunction<(
  fields: Array<[string, string]>,
  path: string,
) => Array<[string, string]>>("buildSourceObjectSelectionFields");
const isSourceObjectNotFoundError = loadFunction<(error: unknown) => boolean>("isSourceObjectNotFoundError");

test("listed file.csv is selected exactly and never normalized as a folder", () => {
  const navigation = resolveSourcePathNavigation("exports/file.csv", [["exports/file.csv", "CSV", "listed"]]);
  assert.deepEqual(navigation, { kind: "select-object", path: "exports/file.csv" });
});

test("an unlisted extensionless key is probed as an exact object", () => {
  const navigation = resolveSourcePathNavigation("archive/current", []);
  assert.deepEqual(navigation, { kind: "probe-object", path: "archive/current" });

  const fields = buildSourceObjectSelectionFields([["Path / Prefix", "before/"]], navigation.path);
  assert.equal(new Map(fields).get("Path / Prefix"), "archive/current");
  assert.equal(new Map(fields).get("__Selection Kind"), "file");
  assert.equal(new Map(fields).get("__Selected Object"), "archive/current");
  assert.equal(new Map(fields).get("__Sample Object"), "archive/current");
});

test("folder metadata or a trailing slash opens a folder", () => {
  assert.deepEqual(
    resolveSourcePathNavigation("archive", [["archive", "folder", "listed"]]),
    { kind: "open-folder", path: "archive" },
  );
  assert.deepEqual(resolveSourcePathNavigation("archive/", []), { kind: "open-folder", path: "archive/" });
});

test("SOURCE_OBJECT_NOT_FOUND is the only object-probe failure that permits folder fallback", () => {
  assert.equal(isSourceObjectNotFoundError({ code: "SOURCE_OBJECT_NOT_FOUND", status: 404 }), true);
  assert.equal(isSourceObjectNotFoundError({ code: "HTTP_404", status: 404 }), false);
  assert.equal(
    isSourceObjectNotFoundError(new Error('{"error":{"code":"SOURCE_OBJECT_NOT_FOUND"}}')),
    true,
  );
});

test("403 permission failures are surfaced without folder fallback", () => {
  assert.equal(isSourceObjectNotFoundError({ code: "FORBIDDEN", status: 403 }), false);
  assert.equal(isSourceObjectNotFoundError({ code: "AUTH_REQUIRED", status: 403 }), false);
  assert.equal(isSourceObjectNotFoundError({ code: "SOURCE_OBJECT_NOT_FOUND", status: 403 }), false);
});

test("the page wires direct probes to code-specific fallback without extension guessing", () => {
  assert.match(
    pageSource,
    /fallbackToFolderOnNotFound\s*&&\s*isSourceObjectNotFoundError\(error\)[\s\S]{0,700}await loadSourceAssetChildren\(assetPath\)/,
  );
  assert.doesNotMatch(pageSource, /navigateSourceAssetPath[\s\S]{0,1200}\.(csv|json|parquet)/i);
});

test("all source calls use the authenticated API client and backend schema contract", () => {
  assert.doesNotMatch(connectorServiceSource, /VITE_BACKEND_DIRECT_URL|postBackendDirect|getBackendDirect/);
  assert.doesNotMatch(connectorServiceSource, /inferSchemaColumnsFromPreview|normalizeConnectorAnalysis/);
  assert.match(
    connectorServiceSource,
    /apiClient\.post<SourceAssetsResponse>\("\/api\/etl\/sources\/assets"/,
  );
  assert.match(
    connectorServiceSource,
    /apiClient\.get<SourceConnectorDefaults>\("\/api\/etl\/sources\/defaults"\)/,
  );
});
