from types import SimpleNamespace
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.models.identity import AuthSessionModel, AuthUserModel, PermissionGrantModel
from app.repositories.permission_repository import create_permission_grant, ensure_demo_permission_grants
from app.schemas.identity import PermissionSummary
from app.services import identity_service
from app.services.identity_service import IdentityService


class DemoPermissionSeedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        PermissionGrantModel.metadata.create_all(bind=self.engine, tables=[PermissionGrantModel.__table__])
        self.db = Session(self.engine)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_existing_admin_grant_does_not_block_demo_seed(self) -> None:
        create_permission_grant(
            self.db,
            resource_type="dataset",
            resource_id="dataset-existing",
            principal_type="user",
            principal_id="existing@example.com",
            actions=["view"],
            created_by="admin",
        )

        created = ensure_demo_permission_grants(
            self.db,
            dataset_ids=["dataset-demo"],
            job_ids=["job-demo"],
            dashboard_ids=["dashboard-demo"],
        )

        self.assertEqual(created, 3)
        seeds = list(self.db.scalars(
            select(PermissionGrantModel).where(PermissionGrantModel.source == "admin_seed")
        ))
        self.assertEqual({(row.resource_type, row.resource_id) for row in seeds}, {
            ("dataset", "dataset-demo"),
            ("etl_job", "job-demo"),
            ("dashboard", "dashboard-demo"),
        })

    def test_demo_seed_is_idempotent(self) -> None:
        args = {
            "dataset_ids": ["dataset-demo"],
            "job_ids": ["job-demo"],
            "dashboard_ids": ["dashboard-demo"],
        }
        self.assertEqual(ensure_demo_permission_grants(self.db, **args), 3)
        self.assertEqual(ensure_demo_permission_grants(self.db, **args), 0)
        self.assertEqual(len(list(self.db.scalars(select(PermissionGrantModel)))), 3)


class IdentityDatabaseSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        AuthUserModel.metadata.create_all(
            bind=self.engine,
            tables=[AuthUserModel.__table__, AuthSessionModel.__table__],
        )
        self.db = Session(self.engine)
        self.db.add(AuthUserModel(
            id="production-admin",
            email="owner@example.com",
            display_name="Production Owner",
            password_salt="salt",
            password_hash="hash",
            role="admin",
            groups=["platform"],
            status="active",
            title="Owner",
        ))
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_admin_users_and_groups_come_from_auth_database(self) -> None:
        service = IdentityService(self.db)
        actor = ActorContext(name="Production Owner", role="admin")
        production_settings = SimpleNamespace(allows_header_auth_fallback=False)
        with (
            patch.object(identity_service, "settings", production_settings),
            patch.object(identity_service, "AuthService"),
            patch.object(service, "_permission_summary", return_value=PermissionSummary()),
        ):
            users = service.list_admin_users(actor).users
            groups = service.list_admin_groups(actor).groups

        self.assertEqual([user.id for user in users], ["production-admin"])
        self.assertEqual([group.id for group in groups], ["platform"])
        self.assertEqual(groups[0].member_count, 1)

    def test_actor_permission_ids_include_database_id_and_email(self) -> None:
        actor = ActorContext(
            id="production-admin",
            email="owner@example.com",
            name="Production Owner",
            role="admin",
        )
        self.assertIn(("user", "production-admin"), actor.principal_ids)
        self.assertIn(("user", "owner@example.com"), actor.principal_ids)
        self.assertIn(("user", "Production Owner"), actor.principal_ids)


if __name__ == "__main__":
    unittest.main()
