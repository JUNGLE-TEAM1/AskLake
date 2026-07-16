#!/usr/bin/env python3
"""Collect deterministic code and contract baselines for staged refactoring.

The collector only reads repository sources and writes JSON under an explicit
output directory. It intentionally avoids importing the application so the
snapshot can be reproduced before service dependencies are installed.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import subprocess
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set


ROOT = Path(__file__).resolve().parents[2]
AUDIT_COMMIT = "06fbe213eaa56506fd7bebf26c6c5739004d03aa"
SCOPES = (
    "frontend/src",
    "backend/app",
    "backend/src",
    "backend/scripts",
    "deploy",
)
SOURCE_SUFFIXES = {
    ".css",
    ".html",
    ".js",
    ".jsx",
    ".mjs",
    ".py",
    ".scss",
    ".sh",
    ".sql",
    ".ts",
    ".tsx",
    ".yaml",
    ".yml",
}
TEXT_SUFFIXES = SOURCE_SUFFIXES | {".json", ".md", ".toml"}
IGNORED_PARTS = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".venv",
    "__pycache__",
    "dist",
    "node_modules",
}
CRITICAL_CONTRACT_FILES = (
    "backend/app/models/etl.py",
    "backend/app/schemas/etl.py",
    "backend/app/services/etl_service.py",
    "backend/scripts/kafka_continuous_stream.py",
    "backend/scripts/spark_job_run.py",
    "deploy/docker-compose.prod.yml",
    "frontend/src/App.tsx",
    "frontend/src/data/appShellData.ts",
    "frontend/src/services/pipelineApi.ts",
)


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def lines(path: Path) -> int:
    content = path.read_bytes()
    if not content:
        return 0
    return content.count(b"\n") + (0 if content.endswith(b"\n") else 1)


def source_files(scope: str) -> List[Path]:
    root = ROOT / scope
    if not root.exists():
        return []
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file()
        and path.suffix.lower() in SOURCE_SUFFIXES
        and not any(part in IGNORED_PARTS for part in path.parts)
    )


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def tarjan_cycles(graph: Mapping[str, Set[str]]) -> List[List[str]]:
    index = 0
    indexes: Dict[str, int] = {}
    lowlinks: Dict[str, int] = {}
    stack: List[str] = []
    on_stack: Set[str] = set()
    groups: List[List[str]] = []

    def visit(node: str) -> None:
        nonlocal index
        indexes[node] = index
        lowlinks[node] = index
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
        component: List[str] = []
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


def python_module(path: Path) -> str:
    value = relative(path)
    if value.startswith("backend/"):
        value = value[len("backend/") :]
    module = value.removesuffix(".py").replace("/", ".")
    return module.removesuffix(".__init__")


def python_graph(paths: Sequence[Path]) -> Dict[str, Set[str]]:
    modules = {python_module(path): path for path in paths}
    graph: Dict[str, Set[str]] = {module: set() for module in modules}
    for module, path in modules.items():
        try:
            tree = ast.parse(text(path))
        except SyntaxError:
            continue
        package = module.split(".")[:-1]
        for node in ast.walk(tree):
            candidates: List[str] = []
            if isinstance(node, ast.Import):
                candidates.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    base = package[: max(0, len(package) - node.level + 1)]
                    if node.module:
                        base.extend(node.module.split("."))
                    candidates.append(".".join(base))
                elif node.module:
                    candidates.append(node.module)
            for candidate in candidates:
                match = next(
                    (
                        known
                        for known in modules
                        if candidate == known or candidate.startswith(f"{known}.")
                    ),
                    None,
                )
                if match and match != module:
                    graph[module].add(match)
    return graph


IMPORT_RE = re.compile(
    r"(?:import\s+(?:[^;]*?\s+from\s+)?|export\s+[^;]*?\s+from\s+|require\()"
    r"[\"'](?P<path>\.{1,2}/[^\"']+)[\"']"
)


def resolve_relative_import(source: Path, value: str, candidates: Mapping[Path, str]) -> Optional[str]:
    base = (source.parent / value).resolve()
    checks = [base]
    checks.extend(base.with_suffix(suffix) for suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs"))
    checks.extend(base / f"index{suffix}" for suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs"))
    for check in checks:
        if check in candidates:
            return candidates[check]
    return None


def javascript_graph(paths: Sequence[Path]) -> Dict[str, Set[str]]:
    candidates = {path.resolve(): relative(path) for path in paths}
    graph: Dict[str, Set[str]] = {relative(path): set() for path in paths}
    for path in paths:
        source = relative(path)
        for match in IMPORT_RE.finditer(text(path)):
            target = resolve_relative_import(path, match.group("path"), candidates)
            if target and target != source:
                graph[source].add(target)
    return graph


def python_metrics(paths: Sequence[Path]) -> Dict[str, Any]:
    functions: List[Dict[str, Any]] = []
    top_level_definitions = 0
    syntax_errors: List[str] = []
    for path in paths:
        try:
            tree = ast.parse(text(path))
        except SyntaxError:
            syntax_errors.append(relative(path))
            continue
        top_level_definitions += sum(
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            for node in tree.body
        )
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                end = getattr(node, "end_lineno", node.lineno)
                functions.append(
                    {
                        "file": relative(path),
                        "name": node.name,
                        "start": node.lineno,
                        "lines": end - node.lineno + 1,
                    }
                )
    return {
        "file_count": len(paths),
        "function_count": len(functions),
        "top_level_definition_count": top_level_definitions,
        "functions_over_100_lines": sum(item["lines"] > 100 for item in functions),
        "largest_functions": sorted(functions, key=lambda item: (-item["lines"], item["file"], item["name"]))[:30],
        "syntax_errors": syntax_errors,
    }


def frontend_metrics(paths: Sequence[Path]) -> Dict[str, Any]:
    imports = hooks = function_like = 0
    per_file: List[Dict[str, Any]] = []
    function_pattern = re.compile(
        r"(?:\bfunction\s+[A-Za-z_$][\w$]*\s*\(|\b(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)"
    )
    for path in paths:
        content = text(path)
        file_imports = len(re.findall(r"(?m)^\s*import\b", content))
        file_hooks = len(re.findall(r"\buse[A-Z][A-Za-z0-9_]*\s*\(", content))
        file_functions = len(function_pattern.findall(content))
        imports += file_imports
        hooks += file_hooks
        function_like += file_functions
        per_file.append(
            {
                "file": relative(path),
                "imports": file_imports,
                "hook_calls": file_hooks,
                "function_like_definitions": file_functions,
            }
        )
    return {
        "file_count": len(paths),
        "import_count": imports,
        "hook_call_count": hooks,
        "function_like_definition_count": function_like,
        "largest_by_hook_calls": sorted(per_file, key=lambda item: (-item["hook_calls"], item["file"]))[:20],
        "largest_by_function_definitions": sorted(
            per_file,
            key=lambda item: (-item["function_like_definitions"], item["file"]),
        )[:20],
    }


def collect_code_metrics() -> Dict[str, Any]:
    scope_paths = {scope: source_files(scope) for scope in SCOPES}
    all_paths = sorted({path for paths in scope_paths.values() for path in paths})
    loc_by_file = {relative(path): lines(path) for path in all_paths}
    scope_summary = {
        scope: {
            "files": len(paths),
            "loc": sum(loc_by_file[relative(path)] for path in paths),
        }
        for scope, paths in scope_paths.items()
    }
    terms: Dict[str, List[str]] = {}
    for term in ("fallback", "mock", "legacy", "compatibility"):
        terms[term] = sorted(
            relative(path)
            for path in all_paths
            if re.search(term, text(path), re.IGNORECASE)
        )

    python_paths = [path for path in all_paths if path.suffix == ".py"]
    frontend_paths = [
        path
        for path in all_paths
        if relative(path).startswith("frontend/src/") and path.suffix in {".ts", ".tsx", ".js", ".jsx"}
    ]
    backend_js_paths = [
        path
        for path in all_paths
        if relative(path).startswith(("backend/src/", "backend/scripts/"))
        and path.suffix in {".ts", ".tsx", ".js", ".jsx", ".mjs"}
    ]
    py_graph = python_graph(python_paths)
    frontend_graph = javascript_graph(frontend_paths)
    backend_js_graph = javascript_graph(backend_js_paths)

    return {
        "schema_version": 1,
        "head": git("rev-parse", "HEAD"),
        "audit_commit": AUDIT_COMMIT,
        "scope": list(SCOPES),
        "summary": {
            "files": len(all_paths),
            "loc": sum(loc_by_file.values()),
            "files_over_500_lines": sum(value >= 500 for value in loc_by_file.values()),
            "files_over_1000_lines": sum(value >= 1000 for value in loc_by_file.values()),
            "files_over_2000_lines": sum(value >= 2000 for value in loc_by_file.values()),
            "files_over_5000_lines": sum(value >= 5000 for value in loc_by_file.values()),
        },
        "by_scope": scope_summary,
        "largest_files": [
            {"file": name, "loc": count}
            for name, count in sorted(loc_by_file.items(), key=lambda item: (-item[1], item[0]))[:50]
        ],
        "python": python_metrics(python_paths),
        "frontend": frontend_metrics(frontend_paths),
        "import_graph": {
            "python_modules": len(py_graph),
            "python_edges": sum(len(value) for value in py_graph.values()),
            "python_cycles": tarjan_cycles(py_graph),
            "frontend_modules": len(frontend_graph),
            "frontend_edges": sum(len(value) for value in frontend_graph.values()),
            "frontend_cycles": tarjan_cycles(frontend_graph),
            "backend_js_modules": len(backend_js_graph),
            "backend_js_edges": sum(len(value) for value in backend_js_graph.values()),
            "backend_js_cycles": tarjan_cycles(backend_js_graph),
        },
        "term_inventory": {
            term: {"file_count": len(paths), "files": paths}
            for term, paths in terms.items()
        },
    }


def literal_values(node: ast.AST) -> List[Any]:
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id == "Literal":
        target = node.slice
        nodes = target.elts if isinstance(target, ast.Tuple) else [target]
        return [item.value for item in nodes if isinstance(item, ast.Constant)]
    return []


def api_routes() -> List[Dict[str, Any]]:
    routes: List[Dict[str, Any]] = []
    for path in sorted((ROOT / "backend/app/api").glob("*.py")):
        try:
            tree = ast.parse(text(path))
        except SyntaxError:
            continue
        prefixes: Dict[str, str] = {}
        for node in tree.body:
            if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Call):
                continue
            if not isinstance(node.value.func, ast.Name) or node.value.func.id != "APIRouter":
                continue
            prefix = ""
            for keyword in node.value.keywords:
                if keyword.arg == "prefix" and isinstance(keyword.value, ast.Constant):
                    prefix = str(keyword.value.value)
            for target in node.targets:
                if isinstance(target, ast.Name):
                    prefixes[target.id] = prefix
        for node in tree.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                    continue
                if not isinstance(decorator.func.value, ast.Name):
                    continue
                router_name = decorator.func.value.id
                method = decorator.func.attr.upper()
                if method not in {"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"}:
                    continue
                route_path = ""
                if decorator.args and isinstance(decorator.args[0], ast.Constant):
                    route_path = str(decorator.args[0].value)
                routes.append(
                    {
                        "method": method,
                        "path": f"{prefixes.get(router_name, '')}{route_path}" or "/",
                        "handler": node.name,
                        "source": relative(path),
                        "line": node.lineno,
                    }
                )
    return sorted(routes, key=lambda item: (item["path"], item["method"], item["source"]))


def model_contracts() -> Dict[str, Any]:
    tables: List[Dict[str, Any]] = []
    literals: Dict[str, List[Any]] = {}
    schema_classes: List[str] = []
    for path in sorted((ROOT / "backend/app").rglob("*.py")):
        try:
            tree = ast.parse(text(path))
        except SyntaxError:
            continue
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                if "/models/" in f"/{relative(path)}":
                    for child in node.body:
                        if (
                            isinstance(child, ast.Assign)
                            and any(isinstance(target, ast.Name) and target.id == "__tablename__" for target in child.targets)
                            and isinstance(child.value, ast.Constant)
                        ):
                            tables.append(
                                {
                                    "class": node.name,
                                    "table": str(child.value.value),
                                    "source": relative(path),
                                }
                            )
                if "/schemas/" in f"/{relative(path)}":
                    schema_classes.append(f"{relative(path)}:{node.name}")
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                name = None
                value = None
                if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                    name = node.targets[0].id
                    value = node.value
                elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                    name = node.target.id
                    value = node.annotation
                values = literal_values(value) if value is not None else []
                if name and values:
                    literals[f"{relative(path)}:{name}"] = values
    migration_root = ROOT / "backend/migrations"
    migrations = []
    if migration_root.exists():
        migrations = [relative(path) for path in sorted(migration_root.rglob("*.py"))]
    return {
        "tables": sorted(tables, key=lambda item: item["table"]),
        "literal_contracts": dict(sorted(literals.items())),
        "schema_classes": sorted(schema_classes),
        "migration_files": migrations,
    }


def package_scripts(path: Path) -> Dict[str, str]:
    payload = json.loads(text(path))
    scripts = payload.get("scripts")
    return dict(sorted(scripts.items())) if isinstance(scripts, dict) else {}


def frontend_contracts() -> Dict[str, Any]:
    app = text(ROOT / "frontend/src/App.tsx")
    shell = text(ROOT / "frontend/src/data/appShellData.ts")
    route_literals = sorted(
        {
            value
            for value in re.findall(r'["\'](/[^"\']*)["\']', app)
            if not value.startswith("/api/")
        }
    )
    wizard_match = re.search(r"wizardFlows\s*:\s*FlowId\[\]\s*=\s*\[(?P<body>[^\]]*)\]", shell)
    wizard_flows = re.findall(r'["\']([^"\']+)["\']', wizard_match.group("body")) if wizard_match else []
    return {"route_literals": route_literals, "wizard_flows": wizard_flows}


def compose_services() -> List[str]:
    compose = text(ROOT / "deploy/docker-compose.prod.yml")
    in_services = False
    services: List[str] = []
    for line in compose.splitlines():
        if line == "services:":
            in_services = True
            continue
        if in_services and line and not line.startswith(" "):
            break
        match = re.match(r"^  ([A-Za-z0-9_.-]+):\s*$", line) if in_services else None
        if match:
            services.append(match.group(1))
    return sorted(services)


def collect_contracts() -> Dict[str, Any]:
    critical = {}
    for name in CRITICAL_CONTRACT_FILES:
        path = ROOT / name
        critical[name] = {
            "sha256": sha256(path),
            "loc": lines(path),
        }
    return {
        "schema_version": 1,
        "head": git("rev-parse", "HEAD"),
        "api_routes": api_routes(),
        "models": model_contracts(),
        "frontend": frontend_contracts(),
        "package_scripts": {
            "backend": package_scripts(ROOT / "backend/package.json"),
            "frontend": package_scripts(ROOT / "frontend/package.json"),
        },
        "production_compose_services": compose_services(),
        "critical_contract_files": critical,
    }


def write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output-dir",
        default="docs/refactor-2026/baseline/artifacts",
        help="Repository-relative output directory for deterministic JSON snapshots.",
    )
    args = parser.parse_args()
    output = (ROOT / args.output_dir).resolve()
    if ROOT not in output.parents:
        raise SystemExit("output directory must stay inside the repository")
    write_json(output / "code-metrics.json", collect_code_metrics())
    write_json(output / "contracts.json", collect_contracts())
    print(relative(output / "code-metrics.json"))
    print(relative(output / "contracts.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
