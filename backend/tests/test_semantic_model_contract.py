from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, permissions_for_actor
from app.models.base import Base
from app.models.identity import PermissionGrantModel
from app.schemas.semantic import SemanticModelCreate
from app.services.semantic_model_service import SEMANTIC_TABLES, SemanticModelService


def test_publish_permission_is_exposed_separately() -> None:
    actor = ActorContext(name="analyst", role="viewer")
    permissions = permissions_for_actor(
        actor,
        grants=[
            {
                "principalType": "user",
                "principalId": "analyst",
                "actions": ["view", "publish"],
            }
        ],
        enforced=True,
    )

    assert permissions.can_view is True
    assert permissions.can_publish is True
    assert permissions.can_manage is False


def test_semantic_model_can_publish_a_valid_connected_definition() -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(
        engine,
        tables=[*SEMANTIC_TABLES, PermissionGrantModel.__table__],
    )
    with Session(engine) as db:
        service = SemanticModelService(db)
        actor = ActorContext(name="admin", role="admin")
        model = service.create(
            SemanticModelCreate.model_validate(
                {
                    "name": "Commerce Sales",
                    "datasets": [{"datasetId": "orders_clean"}],
                    "metrics": [
                        {
                            "name": "revenue",
                            "label": "Revenue",
                            "expression": "sum(order_total)",
                            "datasetId": "orders_clean",
                        }
                    ],
                }
            ),
            actor,
        )

        published = service.publish(model.id, actor)

        assert published.published_version == 2
        assert published.model.status == "published"
        assert published.model.datasets[0].dataset_id == "orders_clean"
