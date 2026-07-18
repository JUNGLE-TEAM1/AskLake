from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.permission_metadata import permission_grants_from_roles, resource_permissions
from app.schemas.dashboard import DashboardCard


def _format_timestamp(value: datetime | None) -> str:
    if value is None:
        value = datetime.now(timezone.utc)
    return value.strftime("%Y-%m-%d %H:%M")


def _iso_timestamp(value: datetime | None) -> str:
    if value is None:
        value = datetime.now(timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _payload_value(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload and payload[key] is not None:
            return payload[key]
    return None


def _row_to_dashboard_card(row: Any) -> DashboardCard:
    payload = row.payload if isinstance(row.payload, dict) else {}
    created_at = getattr(row, "created_at", None)
    updated_at = getattr(row, "updated_at", None)
    has_published_revision = bool(
        getattr(row, "has_published_revision", False)
        or _payload_value(payload, "hasPublishedRevision")
        or _payload_value(payload, "publishedRevisionId")
    )

    card_payload = {
        **payload,
        "createdAt": _payload_value(payload, "createdAt") or _format_timestamp(created_at),
        "createdAtValue": _payload_value(payload, "createdAtValue") or _iso_timestamp(created_at),
        "createdBy": _payload_value(payload, "createdBy") or _payload_value(payload, "created_by") or getattr(row, "owner", None) or "Admin User",
        "createdByProfile": _payload_value(payload, "createdByProfile") or _payload_value(payload, "created_by_profile"),
        "permissionGrants": _payload_value(payload, "permissionGrants") or permission_grants_from_roles(getattr(row, "owner", None) or _payload_value(payload, "owner"), default_actions=["view", "manage", "share"]),
        "permissions": _payload_value(payload, "permissions") or resource_permissions(),
        "datasetId": getattr(row, "dataset_id", None) or _payload_value(payload, "datasetId"),
        "hasPublishedRevision": has_published_revision,
        "id": getattr(row, "id", None) or payload.get("id"),
        "meta": _payload_value(payload, "meta") or "0개 위젯 · 수동 생성",
        "name": getattr(row, "name", None) or _payload_value(payload, "name", "title") or "Untitled dashboard",
        "owner": getattr(row, "owner", None) or _payload_value(payload, "owner") or "Admin User",
        "sourceRunId": getattr(row, "source_run_id", None) or _payload_value(payload, "sourceRunId", "sqlRunId"),
        "status": getattr(row, "status", None) or _payload_value(payload, "status") or "draft",
        "tags": _payload_value(payload, "tags") or "초안 · Dashboard",
        "updated": _payload_value(payload, "updated") or "방금 전",
        "updatedAtValue": _payload_value(payload, "updatedAtValue") or _iso_timestamp(updated_at),
        "widgets": _payload_value(payload, "widgets") or [],
    }

    if "sqlResult" in payload:
        card_payload["sqlResult"] = payload["sqlResult"]

    return DashboardCard(**card_payload)


def list_dashboard_cards(db: Session) -> list[DashboardCard]:
    result = db.execute(
        text(
            """
            SELECT
                id,
                name,
                owner,
                status,
                dataset_id,
                source_run_id,
                published_revision_id,
                has_published_revision,
                payload,
                created_at,
                updated_at
            FROM dashboards
            """
        )
    )
    return [_row_to_dashboard_card(row) for row in result]


def get_dashboard_card(db: Session, dashboard_id: str) -> DashboardCard | None:
    result = db.execute(
        text(
            """
            SELECT
                id,
                name,
                owner,
                status,
                dataset_id,
                source_run_id,
                published_revision_id,
                has_published_revision,
                payload,
                created_at,
                updated_at
            FROM dashboards
            WHERE id = :dashboard_id
            """
        ),
        {"dashboard_id": dashboard_id},
    ).first()
    if result is None:
        return None
    return _row_to_dashboard_card(result)


def save_dashboard_card(db: Session, dashboard: DashboardCard) -> DashboardCard:
    existing = db.execute(
        text(
            """
            SELECT payload, published_revision_id, has_published_revision
            FROM dashboards
            WHERE id = :dashboard_id
            """
        ),
        {"dashboard_id": dashboard.id},
    ).first()
    existing_payload = existing.payload if existing is not None and isinstance(existing.payload, dict) else {}
    existing_published_revision_id = existing.published_revision_id if existing is not None else None
    payload = {
        **existing_payload,
        **dashboard.model_dump(by_alias=True, exclude_none=True, mode="json"),
    }
    published_revision_id = payload.get("publishedRevisionId") or existing_published_revision_id
    if published_revision_id:
        payload["publishedRevisionId"] = published_revision_id
    has_published_revision = bool(dashboard.has_published_revision or existing_published_revision_id)
    payload["hasPublishedRevision"] = has_published_revision
    db.execute(
        text(
            """
            INSERT INTO dashboards (
                id,
                name,
                owner,
                status,
                dataset_id,
                source_run_id,
                published_revision_id,
                has_published_revision,
                payload,
                updated_at
            )
            VALUES (
                :id,
                :name,
                :owner,
                :status,
                :dataset_id,
                :source_run_id,
                :published_revision_id,
                :has_published_revision,
                CAST(:payload AS jsonb),
                now()
            )
            ON CONFLICT (id)
            DO UPDATE SET
                name = EXCLUDED.name,
                owner = EXCLUDED.owner,
                status = EXCLUDED.status,
                dataset_id = EXCLUDED.dataset_id,
                source_run_id = EXCLUDED.source_run_id,
                published_revision_id = EXCLUDED.published_revision_id,
                has_published_revision = EXCLUDED.has_published_revision,
                payload = EXCLUDED.payload,
                updated_at = now()
            """
        ),
        {
            "id": dashboard.id,
            "name": dashboard.name,
            "owner": dashboard.owner,
            "status": dashboard.status.value if hasattr(dashboard.status, "value") else dashboard.status,
            "dataset_id": dashboard.dataset_id,
            "source_run_id": dashboard.source_run_id,
            "published_revision_id": published_revision_id,
            "has_published_revision": has_published_revision,
            "payload": json.dumps(payload, ensure_ascii=False),
        },
    )
    replace_dashboard_tags(db, dashboard.id, split_dashboard_tags(dashboard.tags))
    return dashboard


def delete_dashboard_card(db: Session, dashboard_id: str) -> bool:
    result = db.execute(
        text("DELETE FROM dashboards WHERE id = :dashboard_id RETURNING id"),
        {"dashboard_id": dashboard_id},
    ).first()
    return result is not None


def replace_dashboard_tags(db: Session, dashboard_id: str, tags: list[str]) -> None:
    db.execute(text("DELETE FROM dashboard_tags WHERE dashboard_id = :dashboard_id"), {"dashboard_id": dashboard_id})
    for tag in tags:
        db.execute(
            text(
                """
                INSERT INTO dashboard_tags (dashboard_id, tag)
                VALUES (:dashboard_id, :tag)
                ON CONFLICT (dashboard_id, tag) DO NOTHING
                """
            ),
            {"dashboard_id": dashboard_id, "tag": tag},
        )


def split_dashboard_tags(tags: str) -> list[str]:
    normalized_tags: list[str] = []
    for pipe_part in tags.split("|"):
        for tag in pipe_part.split("·"):
            stripped = tag.strip()
            if stripped and stripped not in normalized_tags:
                normalized_tags.append(stripped)
    return normalized_tags
