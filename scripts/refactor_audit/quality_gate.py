#!/usr/bin/env python3
"""Ratchet structural debt without requiring the legacy baseline to be clean."""

from __future__ import annotations

import argparse
import ast
from datetime import date
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Iterable, Mapping


SOURCE_ROOTS = ("backend/app", "backend/scripts", "backend/src", "frontend/src", "deploy")
SOURCE_SUFFIXES = {".css", ".js", ".jsx", ".mjs", ".py", ".sh", ".ts", ".tsx", ".yaml", ".yml"}
IGNORED = {".git", ".venv", "__pycache__", "dist", "node_modules"}
IMPORT_RE = re.compile(
    r"(?:import\s+(?:[^;]*?\s+from\s+)?|export\s+[^;]*?\s+from\s+|require\()"
    r"[\"'](?P<path>\.{1,2}/[^\"']+)[\"']"
)
JS_FUNCTION_RE = re.compile(
    r"\bfunction\s+(?P<function>[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{|"
    r"\b(?:const|let)\s+(?P<arrow>[A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?"
    r"(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{",
    re.DOTALL,
)
EXCEPTION_ALLOWANCE_FIELDS = (
    "oversizedFiles",
    "oversizedPythonFunctions",
    "oversizedJavascriptFunctions",
)


def source_files(root: Path) -> list[Path]:
    return sorted(
        path
        for name in SOURCE_ROOTS
        for path in (root / name).rglob("*")
        if path.is_file()
        and path.suffix.lower() in SOURCE_SUFFIXES
        and not any(part in IGNORED for part in path.parts)
    )


def relative(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def line_count(path: Path) -> int:
    content = path.read_bytes()
    return content.count(b"\n") + (0 if not content or content.endswith(b"\n") else 1)


class FunctionVisitor(ast.NodeVisitor):
    def __init__(self, file_name: str) -> None:
        self.file_name = file_name
        self.stack: list[str] = []
        self.functions: dict[str, int] = {}

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.stack.append(node.name)
        self.generic_visit(node)
        self.stack.pop()

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        name = ".".join([*self.stack, node.name])
        end = getattr(node, "end_lineno", node.lineno)
        self.functions[f"{self.file_name}::{name}"] = end - node.lineno + 1
        self.stack.append(node.name)
        self.generic_visit(node)
        self.stack.pop()

    visit_FunctionDef = _visit_function
    visit_AsyncFunctionDef = _visit_function


def python_functions(root: Path, paths: Iterable[Path]) -> dict[str, int]:
    found: dict[str, int] = {}
    for path in paths:
        if path.suffix != ".py":
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError:
            continue
        visitor = FunctionVisitor(relative(root, path))
        visitor.visit(tree)
        found.update(visitor.functions)
    return found


def _brace_block_lines(content: str, start: int) -> int:
    depth = 0
    quote: str | None = None
    escaped = False
    line_comment = False
    block_comment = False
    start_line = content.count("\n", 0, start) + 1
    for index in range(start, len(content)):
        character = content[index]
        following = content[index + 1] if index + 1 < len(content) else ""
        if line_comment:
            if character == "\n":
                line_comment = False
            continue
        if block_comment:
            if character == "*" and following == "/":
                block_comment = False
            continue
        if quote:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == quote:
                quote = None
            continue
        if character == "/" and following == "/":
            line_comment = True
            continue
        if character == "/" and following == "*":
            block_comment = True
            continue
        if character in {'"', "'", "`"}:
            quote = character
            continue
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return content.count("\n", 0, index) + 1 - start_line + 1
    return content.count("\n", start) + 1


def javascript_functions(root: Path, paths: Iterable[Path]) -> dict[str, int]:
    found: dict[str, int] = {}
    for path in paths:
        if path.suffix not in {".js", ".jsx", ".mjs", ".ts", ".tsx"}:
            continue
        content = path.read_text(encoding="utf-8", errors="replace")
        for match in JS_FUNCTION_RE.finditer(content):
            name = match.group("function") or match.group("arrow")
            key = f"{relative(root, path)}::{name}"
            found[key] = max(found.get(key, 0), _brace_block_lines(content, match.end() - 1))
    return found


def _tarjan(graph: Mapping[str, set[str]]) -> list[list[str]]:
    index = 0
    indexes: dict[str, int] = {}
    lowlinks: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    groups: list[list[str]] = []

    def visit(node: str) -> None:
        nonlocal index
        indexes[node] = lowlinks[node] = index
        index += 1
        stack.append(node)
        on_stack.add(node)
        for target in sorted(graph.get(node, set())):
            if target not in indexes:
                visit(target)
                lowlinks[node] = min(lowlinks[node], lowlinks[target])
            elif target in on_stack:
                lowlinks[node] = min(lowlinks[node], indexes[target])
        if lowlinks[node] != indexes[node]:
            return
        component: list[str] = []
        while stack:
            current = stack.pop()
            on_stack.remove(current)
            component.append(current)
            if current == node:
                break
        if len(component) > 1 or node in graph.get(node, set()):
            groups.append(sorted(component))

    for node in sorted(graph):
        if node not in indexes:
            visit(node)
    return sorted(groups)


def import_cycles(root: Path, paths: list[Path]) -> dict[str, list[list[str]]]:
    python_paths = [path for path in paths if path.suffix == ".py" and "/backend/" in f"/{path}"]
    py_modules = {
        relative(root, path).removeprefix("backend/").removesuffix(".py").replace("/", ".").removesuffix(".__init__"): path
        for path in python_paths
    }
    py_graph = {name: set() for name in py_modules}
    for module, path in py_modules.items():
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            candidates: list[str] = []
            if isinstance(node, ast.Import):
                candidates.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                candidates.append(node.module)
            for candidate in candidates:
                match = next((known for known in py_modules if candidate == known or candidate.startswith(f"{known}.")), None)
                if match and match != module:
                    py_graph[module].add(match)

    js_paths = [path for path in paths if path.suffix in {".js", ".jsx", ".mjs", ".ts", ".tsx"}]
    candidates = {path.resolve(): relative(root, path) for path in js_paths}
    js_graph = {relative(root, path): set() for path in js_paths}
    for path in js_paths:
        content = path.read_text(encoding="utf-8", errors="replace")
        for match in IMPORT_RE.finditer(content):
            base = (path.parent / match.group("path")).resolve()
            checks = [base, *(base.with_suffix(suffix) for suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs")), *(base / f"index{suffix}" for suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs"))]
            target = next((candidates[item] for item in checks if item in candidates), None)
            if target and target != relative(root, path):
                js_graph[relative(root, path)].add(target)
    return {"python": _tarjan(py_graph), "javascript": _tarjan(js_graph)}


def collect(root: Path, file_limit: int, function_limit: int) -> dict[str, Any]:
    paths = source_files(root)
    sizes = {relative(root, path): line_count(path) for path in paths}
    functions = python_functions(root, paths)
    javascript = javascript_functions(root, paths)
    return {
        "oversizedFiles": {name: size for name, size in sizes.items() if size > file_limit},
        "oversizedPythonFunctions": {name: size for name, size in functions.items() if size > function_limit},
        "oversizedJavascriptFunctions": {name: size for name, size in javascript.items() if size > function_limit},
        "importCycles": import_cycles(root, paths),
    }


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


def write_baseline(root: Path, output: Path, file_limit: int, function_limit: int) -> None:
    payload = {
        "schemaVersion": 1,
        "generatedFrom": git(root, "rev-parse", "HEAD"),
        "owner": "data-platform",
        "reviewBy": "2026-10-31",
        "fileLimit": file_limit,
        "functionLimit": function_limit,
        "exceptions": [],
        **collect(root, file_limit, function_limit),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def changed_files(root: Path, base: str) -> set[str]:
    try:
        return set(filter(None, git(root, "diff", "--name-only", base).splitlines()))
    except subprocess.CalledProcessError:
        return set()


def validate_migrations(root: Path) -> list[str]:
    failures: list[str] = []
    seen_revisions: dict[str, str] = {}
    for path in sorted((root / "backend/migrations").rglob("*.py")) if (root / "backend/migrations").exists() else []:
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError as error:
            failures.append(f"migration syntax error: {relative(root, path)}:{error.lineno}")
            continue
        revision = None
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "revision" for target in node.targets) and isinstance(node.value, ast.Constant):
                revision = str(node.value.value)
        if revision:
            if revision in seen_revisions:
                failures.append(f"duplicate migration revision {revision}: {seen_revisions[revision]}, {relative(root, path)}")
            seen_revisions[revision] = relative(root, path)
    return failures


def exception_allowances(
    baseline: Mapping[str, Any],
) -> tuple[dict[str, dict[str, int]], list[str]]:
    allowances = {field: {} for field in EXCEPTION_ALLOWANCE_FIELDS}
    failures: list[str] = []
    seen_ids: set[str] = set()
    for index, exception in enumerate(baseline.get("exceptions", [])):
        if not isinstance(exception, Mapping):
            failures.append(f"quality gate exception {index} must be an object")
            continue
        exception_id = str(exception.get("id") or "").strip()
        missing = [
            key
            for key in ("id", "owner", "reason", "expiresAt")
            if not str(exception.get(key) or "").strip()
        ]
        exception_failures: list[str] = []
        if missing:
            exception_failures.append(
                "quality gate exception requires id, owner, reason, and expiresAt"
            )
        if exception_id in seen_ids:
            exception_failures.append(f"duplicate quality gate exception id: {exception_id}")
        elif exception_id:
            seen_ids.add(exception_id)

        expires_at: date | None = None
        try:
            expires_at = date.fromisoformat(str(exception.get("expiresAt") or ""))
        except ValueError:
            exception_failures.append(
                f"invalid quality gate exception expiry: {exception_id or index}"
            )
        if expires_at is not None and expires_at < date.today():
            exception_failures.append(
                f"expired quality gate exception: {exception_id or index}"
            )

        local_allowances = {field: {} for field in EXCEPTION_ALLOWANCE_FIELDS}
        allowance_count = 0
        for field in EXCEPTION_ALLOWANCE_FIELDS:
            values = exception.get(field, {})
            if not isinstance(values, Mapping):
                exception_failures.append(
                    f"quality gate exception {exception_id or index} {field} must be an object"
                )
                continue
            for target, maximum in values.items():
                target_name = str(target or "").strip()
                if not target_name:
                    exception_failures.append(
                        f"quality gate exception {exception_id or index} has an empty {field} target"
                    )
                    continue
                if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum <= 0:
                    exception_failures.append(
                        f"quality gate exception {exception_id or index} {target_name} needs a positive integer ceiling"
                    )
                    continue
                if target_name in allowances[field] or target_name in local_allowances[field]:
                    exception_failures.append(
                        f"duplicate quality gate exception target: {field}::{target_name}"
                    )
                    continue
                local_allowances[field][target_name] = maximum
                allowance_count += 1
        if allowance_count == 0:
            exception_failures.append(
                f"quality gate exception {exception_id or index} needs at least one exact allowance"
            )
        failures.extend(exception_failures)
        if exception_failures:
            continue
        for field, values in local_allowances.items():
            allowances[field].update(values)
    return allowances, failures


def is_exception_allowed(
    allowances: Mapping[str, Mapping[str, int]],
    field: str,
    target: str,
    current_size: int,
) -> bool:
    maximum = allowances.get(field, {}).get(target)
    return maximum is not None and current_size == maximum


def compare(root: Path, baseline: Mapping[str, Any], base: str) -> list[str]:
    file_limit = int(baseline.get("fileLimit", 1_000))
    function_limit = int(baseline.get("functionLimit", 100))
    current = collect(root, file_limit, function_limit)
    allowances, failures = exception_allowances(baseline)
    for field, targets in allowances.items():
        current_sizes = current[field]
        for target, maximum in targets.items():
            current_size = current_sizes.get(target)
            if current_size is None:
                failures.append(
                    f"unused quality gate exception target: {field}::{target}"
                )
            elif current_size != maximum:
                failures.append(
                    "quality gate exception ceiling must equal current size: "
                    f"{field}::{target} ({maximum} != {current_size})"
                )
    old_files = baseline.get("oversizedFiles", {})
    for name, size in current["oversizedFiles"].items():
        allowed = old_files.get(name)
        if allowed is None and not is_exception_allowed(
            allowances,
            "oversizedFiles",
            name,
            size,
        ):
            failures.append(f"new file exceeds {file_limit} lines: {name} ({size})")
        elif (
            allowed is not None
            and size > int(allowed)
            and not is_exception_allowed(allowances, "oversizedFiles", name, size)
        ):
            failures.append(f"oversized file grew: {name} ({allowed} -> {size})")
    old_functions = baseline.get("oversizedPythonFunctions", {})
    for name, size in current["oversizedPythonFunctions"].items():
        allowed = old_functions.get(name)
        if allowed is None and not is_exception_allowed(
            allowances,
            "oversizedPythonFunctions",
            name,
            size,
        ):
            failures.append(f"new Python function exceeds {function_limit} lines: {name} ({size})")
        elif (
            allowed is not None
            and size > int(allowed)
            and not is_exception_allowed(
                allowances,
                "oversizedPythonFunctions",
                name,
                size,
            )
        ):
            failures.append(f"oversized Python function grew: {name} ({allowed} -> {size})")
    old_javascript = baseline.get("oversizedJavascriptFunctions", {})
    for name, size in current["oversizedJavascriptFunctions"].items():
        allowed = old_javascript.get(name)
        if allowed is None and not is_exception_allowed(
            allowances,
            "oversizedJavascriptFunctions",
            name,
            size,
        ):
            failures.append(f"new JavaScript/TypeScript function exceeds {function_limit} lines: {name} ({size})")
        elif (
            allowed is not None
            and size > int(allowed)
            and not is_exception_allowed(
                allowances,
                "oversizedJavascriptFunctions",
                name,
                size,
            )
        ):
            failures.append(f"oversized JavaScript/TypeScript function grew: {name} ({allowed} -> {size})")
    for language, cycles in current["importCycles"].items():
        previous = {tuple(item) for item in baseline.get("importCycles", {}).get(language, [])}
        for cycle in cycles:
            if tuple(cycle) not in previous:
                failures.append(f"new {language} import cycle: {' -> '.join(cycle)}")
    changed = changed_files(root, base)
    if any(name.startswith(("backend/app/api/", "backend/app/schemas/")) for name in changed) and not changed.intersection({"docs/03-api-reference.md", "docs/02-architecture.md"}):
        failures.append("API/schema changed without docs/03-api-reference.md or docs/02-architecture.md")
    if any(name.startswith(("deploy/", ".github/workflows/")) for name in changed) and not changed.intersection({"docs/04-development-guide.md", "docs/system-guardrails.md"}):
        failures.append("CI/deploy changed without development or guardrail documentation")
    failures.extend(validate_migrations(root))
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--baseline", type=Path, default=Path("docs/refactor-2026/quality-gate-baseline.json"))
    parser.add_argument("--base", default="origin/dev")
    parser.add_argument("--write-baseline", action="store_true")
    parser.add_argument("--file-limit", type=int, default=1_000)
    parser.add_argument("--function-limit", type=int, default=100)
    args = parser.parse_args()
    root = args.root.resolve()
    baseline_path = args.baseline if args.baseline.is_absolute() else root / args.baseline
    if args.write_baseline:
        write_baseline(root, baseline_path, args.file_limit, args.function_limit)
        print(f"wrote quality baseline: {baseline_path}")
        return 0
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    failures = compare(root, baseline, args.base)
    if failures:
        print("quality gate failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    print("quality gate passed: no structural or contract-governance regression")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
