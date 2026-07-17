import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.models.identity import AuthSessionModel, AuthUserModel, PermissionGrantModel
from app.repositories.permission_repository import list_permission_grants_by_resource
from app.schemas.identity import PermissionSummary
from app.services.identity_service import IdentityService


class LegacyPermissionSeedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        PermissionGrantModel.metadata.create_all(bind=self.engine, tables=[PermissionGrantModel.__table__])
        self.db = Session(self.engine)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_legacy_demo_grants_are_never_returned_as_permissions(self) -> None:
        self.db.add_all([
            PermissionGrantModel(
                id="legacy-active-seed",
                resource_type="dataset",
                resource_id="dataset-demo",
                principal_type="group",
                principal_id="analytics",
                actions=["view", "query"],
                source="admin_seed",
                created_by="system",
            ),
            PermissionGrantModel(
                id="legacy-deleted-seed",
                resource_type="dataset",
                resource_id="dataset-demo",
                principal_type="group",
                principal_id="analytics",
                actions=[],
                source="admin_seed_deleted",
                created_by="system",
            ),
        ])
        self.db.commit()

        self.assertEqual(
            list_permission_grants_by_resource(self.db, [("dataset", "dataset-demo")]),
            {("dataset", "dataset-demo"): []},
        )

    def test_multiple_resources_are_loaded_with_one_select(self) -> None:
        create_permission_grant(
            self.db,
            resource_type="etl_job",
            resource_id="job-one",
            principal_type="user",
            principal_id="reader@example.com",
            actions=["view"],
            created_by="admin",
        )
        create_permission_grant(
            self.db,
            resource_type="etl_job",
            resource_id="job-two",
            principal_type="group",
            principal_id="ops",
            actions=["run"],
            created_by="admin",
        )

        with patch.object(self.db, "scalars", wraps=self.db.scalars) as scalars:
            grouped = list_permission_grants_by_resource(
                self.db,
                [
                    ("etl_job", "job-one"),
                    ("etl_job", "job-two"),
                    ("etl_job", "job-without-grants"),
                ],
            )

        self.assertEqual(scalars.call_count, 1)
        self.assertEqual(len(grouped[("etl_job", "job-one")]), 1)
        self.assertEqual(len(grouped[("etl_job", "job-two")]), 1)
        self.assertEqual(grouped[("etl_job", "job-without-grants")], [])


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
        with (
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

    def test_current_user_uses_authenticated_identity_without_demo_profile_reconstruction(self) -> None:
        service = IdentityService(self.db)
        actor = ActorContext(
            id="real-user-42",
            email="real.user@example.com",
            name="Real User",
            role="viewer",
            groups=("research",),
            title="Research Analyst",
        )
        with patch.object(service, "_permission_summary", return_value=PermissionSummary()):
            current = service.get_current_user(actor)

        self.assertEqual(current.id, "real-user-42")
        self.assertEqual(current.email, "real.user@example.com")
        self.assertEqual([group.id for group in current.groups], ["research"])
        self.assertEqual(current.profile.title, "Research Analyst")


if __name__ == "__main__":
    unittest.main()
