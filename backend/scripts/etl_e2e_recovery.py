from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any, Optional
from urllib.parse import urlparse
import uuid
import xml.etree.ElementTree as ET


PROFILE_RANK = {"pr": 0, "release": 1, "nightly": 2}
SECRET_ENV_KEYS = {
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "MINIO_ACCESS_KEY",
    "MINIO_ROOT_PASSWORD",
    "MINIO_ROOT_USER",
    "MINIO_SECRET_KEY",
}
SECRET_PATTERN = re.compile(
    r"(?i)(password|secret|token|access[_-]?key)(\s*[=:]\s*)([^\s,;]+)"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


def default_registry_path() -> Path:
    return Path(__file__).with_name("etl-e2e-recovery-scenarios.json")


def load_registry(path: Path) -> dict[str, Any]:
    registry = json.loads(path.read_text(encoding="utf-8"))
    validate_registry(registry)
    return registry


def validate_registry(registry: dict[str, Any]) -> None:
    if registry.get("schemaVersion") != 1:
        raise ValueError("Recovery registry schemaVersion must be 1.")
    if registry.get("profiles") != list(PROFILE_RANK):
        raise ValueError("Recovery profiles must be pr, release, nightly in order.")
    checks = registry.get("checks")
    scenarios = registry.get("scenarios")
    if not isinstance(checks, dict) or not checks:
        raise ValueError("Recovery registry must declare checks.")
    if not isinstance(scenarios, list) or not scenarios:
        raise ValueError("Recovery registry must declare scenarios.")
    _validate_checks(checks)
    _validate_scenarios(scenarios, checks)


def _validate_checks(checks: dict[str, Any]) -> None:
    for check_id, check in checks.items():
        if check.get("minimumProfile") not in PROFILE_RANK:
            raise ValueError(f"Check {check_id} has an invalid minimumProfile.")
        if not check.get("command") or not isinstance(check["command"], list):
            raise ValueError(f"Check {check_id} must declare a command list.")
        if int(check.get("timeoutSeconds", 0)) <= 0:
            raise ValueError(f"Check {check_id} must declare a positive timeoutSeconds.")


def _validate_scenarios(scenarios: list[dict[str, Any]], checks: dict[str, Any]) -> None:
    required = {
        "id", "minimumProfile", "initialState", "injection", "expectedState",
        "timeoutSeconds", "recovery", "checks", "evidence",
    }
    identifiers: set[str] = set()
    for scenario in scenarios:
        missing = required - set(scenario)
        if missing:
            raise ValueError(f"Scenario {scenario.get('id', '<unknown>')} is missing {sorted(missing)}.")
        if scenario["id"] in identifiers:
            raise ValueError(f"Duplicate recovery scenario: {scenario['id']}")
        identifiers.add(scenario["id"])
        if scenario["minimumProfile"] not in PROFILE_RANK:
            raise ValueError(f"Scenario {scenario['id']} has an invalid minimumProfile.")
        if scenario["recovery"] not in {"automatic", "operator"}:
            raise ValueError(f"Scenario {scenario['id']} has an invalid recovery owner.")
        unknown = set(scenario["checks"]) - set(checks)
        if unknown:
            raise ValueError(f"Scenario {scenario['id']} references unknown checks: {sorted(unknown)}")


def included(minimum_profile: str, selected_profile: str) -> bool:
    return PROFILE_RANK[minimum_profile] <= PROFILE_RANK[selected_profile]


def selected_check_ids(registry: dict[str, Any], profile: str) -> list[str]:
    return [
        check_id for check_id, check in registry["checks"].items()
        if included(check["minimumProfile"], profile)
    ]


def guard_isolated_profile(profile: str, environment: dict[str, str]) -> None:
    if profile != "nightly":
        return
    if environment.get("ASKLAKE_E2E_ISOLATED_ENV") != "true":
        raise ValueError("Nightly recovery tests require ASKLAKE_E2E_ISOLATED_ENV=true.")
    base_url = environment.get("ASKLAKE_CONTINUOUS_E2E_BASE_URL", "http://127.0.0.1:8080")
    hostname = (urlparse(base_url).hostname or "").lower()
    allowed = {"127.0.0.1", "localhost", "::1"}
    if hostname not in allowed:
        raise ValueError(f"Nightly recovery target must be loopback, received {hostname or '<empty>'}.")


def safe_environment(spec: dict[str, Any], correlation_id: str) -> dict[str, str]:
    environment = {key: value for key, value in os.environ.items() if key not in SECRET_ENV_KEYS}
    environment.update({str(key): str(value) for key, value in spec.get("environment", {}).items()})
    # Nested npm/Node checks must use the same supported interpreter as the
    # harness instead of falling back to an older host-level python3.
    environment.setdefault("ASKLAKE_FASTAPI_PYTHON", sys.executable)
    environment["ASKLAKE_E2E_CORRELATION_ID"] = correlation_id
    environment["ASKLAKE_CORRELATION_ID"] = correlation_id
    return environment


def resolved_command(spec: dict[str, Any]) -> list[str]:
    python = os.environ.get("ASKLAKE_FASTAPI_PYTHON") or sys.executable
    return [python if value == "{python}" else str(value) for value in spec["command"]]


def redact(value: str) -> str:
    return SECRET_PATTERN.sub(lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", value)


def output_tail(value: str, limit: int = 12_000) -> str:
    redacted = redact(value or "")
    return redacted if len(redacted) <= limit else redacted[-limit:]


def run_check(check_id: str, spec: dict[str, Any], correlation_id: str, dry_run: bool) -> dict[str, Any]:
    command = resolved_command(spec)
    started_at = utc_now()
    started = time.monotonic()
    base = {
        "id": check_id,
        "command": command,
        "correlationId": correlation_id,
        "startedAt": started_at,
    }
    if dry_run:
        return {**base, "durationMs": 0, "status": "planned", "stdout": "", "stderr": ""}
    try:
        result = subprocess.run(
            command,
            cwd=repository_root() / spec["cwd"],
            env=safe_environment(spec, correlation_id),
            capture_output=True,
            text=True,
            timeout=int(spec["timeoutSeconds"]),
            check=False,
        )
        status = "passed" if result.returncode == 0 else "failed"
        return {
            **base,
            "durationMs": round((time.monotonic() - started) * 1000),
            "exitCode": result.returncode,
            "status": status,
            "stdout": output_tail(result.stdout),
            "stderr": output_tail(result.stderr),
        }
    except subprocess.TimeoutExpired as error:
        return {
            **base,
            "durationMs": round((time.monotonic() - started) * 1000),
            "exitCode": None,
            "status": "timed_out",
            "stdout": output_tail(_decoded(error.stdout)),
            "stderr": output_tail(_decoded(error.stderr)),
        }


def _decoded(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value or "")


def scenario_results(registry: dict[str, Any], profile: str, checks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    check_status = {check["id"]: check["status"] for check in checks}
    results = []
    for scenario in registry["scenarios"]:
        if not included(scenario["minimumProfile"], profile):
            continue
        eligible = [check_id for check_id in scenario["checks"] if check_id in check_status]
        statuses = [check_status[check_id] for check_id in eligible]
        if statuses and all(status == "passed" for status in statuses):
            status = "passed"
        elif statuses and all(status == "planned" for status in statuses):
            status = "planned"
        else:
            status = "failed"
        results.append({**scenario, "checks": eligible, "status": status})
    return results


def write_artifacts(output_dir: Path, report: dict[str, Any]) -> dict[str, str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "json": output_dir / "recovery-report.json",
        "junit": output_dir / "recovery-junit.xml",
        "summary": output_dir / "recovery-summary.md",
    }
    paths["json"].write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    paths["junit"].write_text(junit_xml(report), encoding="utf-8")
    paths["summary"].write_text(human_summary(report), encoding="utf-8")
    return {key: str(value) for key, value in paths.items()}


def junit_xml(report: dict[str, Any]) -> str:
    failures = sum(1 for scenario in report["scenarios"] if scenario["status"] == "failed")
    suite = ET.Element("testsuite", {
        "name": f"asklake-etl-recovery-{report['profile']}",
        "tests": str(len(report["scenarios"])),
        "failures": str(failures),
    })
    for scenario in report["scenarios"]:
        case = ET.SubElement(suite, "testcase", {"classname": "etl.recovery", "name": scenario["id"]})
        if scenario["status"] == "failed":
            ET.SubElement(case, "failure", {"message": "Recovery scenario failed"}).text = scenario["expectedState"]
        elif scenario["status"] == "planned":
            ET.SubElement(case, "skipped", {"message": "dry-run"})
    return ET.tostring(suite, encoding="unicode", xml_declaration=True) + "\n"


def human_summary(report: dict[str, Any]) -> str:
    lines = [
        "# AskLake ETL E2E·복구 검증 결과",
        "",
        f"- profile: `{report['profile']}`",
        f"- run/correlation ID: `{report['correlationId']}`",
        f"- status: `{report['status']}`",
        "",
        "| 시나리오 | 결과 | 복구 | 검증기 |",
        "|---|---|---|---|",
    ]
    for scenario in report["scenarios"]:
        lines.append(
            f"| `{scenario['id']}` | {scenario['status']} | {scenario['recovery']} | "
            f"{', '.join(f'`{item}`' for item in scenario['checks'])} |"
        )
    lines.extend(["", "## Check 결과", "", "| Check | 결과 | 소요(ms) |", "|---|---|---:|"])
    for check in report["checks"]:
        lines.append(f"| `{check['id']}` | {check['status']} | {check['durationMs']} |")
    return "\n".join(lines) + "\n"


def execute(profile: str, registry: dict[str, Any], output_dir: Path, dry_run: bool) -> tuple[dict[str, Any], dict[str, str]]:
    guard_isolated_profile(profile, dict(os.environ))
    correlation_id = f"e2e-{uuid.uuid4()}"
    started_at = utc_now()
    checks = [
        run_check(check_id, registry["checks"][check_id], correlation_id, dry_run)
        for check_id in selected_check_ids(registry, profile)
    ]
    scenarios = scenario_results(registry, profile, checks)
    failed = any(check["status"] in {"failed", "timed_out"} for check in checks)
    report = {
        "schemaVersion": 1,
        "correlationId": correlation_id,
        "profile": profile,
        "startedAt": started_at,
        "endedAt": utc_now(),
        "status": "failed" if failed else ("planned" if dry_run else "passed"),
        "checks": checks,
        "scenarios": scenarios,
    }
    return report, write_artifacts(output_dir, report)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run AskLake ETL E2E and recovery profiles.")
    parser.add_argument("--profile", choices=PROFILE_RANK, default="pr")
    parser.add_argument("--registry", type=Path, default=default_registry_path())
    parser.add_argument("--output-dir", type=Path, default=repository_root() / ".artifacts" / "etl-e2e-recovery")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--list", action="store_true")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    arguments = build_parser().parse_args(argv)
    registry = load_registry(arguments.registry)
    if arguments.list:
        for scenario in registry["scenarios"]:
            print(f"{scenario['minimumProfile']:7} {scenario['id']}")
        return 0
    try:
        report, paths = execute(arguments.profile, registry, arguments.output_dir, arguments.dry_run)
    except ValueError as error:
        print(f"etl-e2e-recovery: {error}", file=sys.stderr)
        return 2
    print(json.dumps({"status": report["status"], "profile": report["profile"], "artifacts": paths}))
    return 0 if report["status"] in {"passed", "planned"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
