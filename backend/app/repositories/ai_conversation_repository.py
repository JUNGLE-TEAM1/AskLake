from sqlalchemy import delete, func, inspect, select
from sqlalchemy.orm import Session

from app.models.ai import AiConversationMessageModel, AiConversationModel

_schema_ready_bind_ids: set[int] = set()


def ensure_ai_conversation_schema(db: Session) -> None:
    bind = db.get_bind()
    bind_key = id(bind)
    if bind_key in _schema_ready_bind_ids:
        return

    with bind.begin() as connection:
        table_names = set(inspect(connection).get_table_names())
        if AiConversationModel.__tablename__ not in table_names:
            AiConversationModel.__table__.create(bind=connection)
        if AiConversationMessageModel.__tablename__ not in table_names:
            AiConversationMessageModel.__table__.create(bind=connection)

    _schema_ready_bind_ids.add(bind_key)


class AiConversationRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_conversations(self, owner_key: str) -> list[AiConversationModel]:
        ensure_ai_conversation_schema(self.db)
        result = self.db.execute(
            select(AiConversationModel)
            .where(AiConversationModel.owner_key == owner_key)
            .order_by(
                AiConversationModel.updated_at.desc(),
                AiConversationModel.id.asc(),
            )
        )
        return list(result.scalars().all())

    def get_conversation(self, conversation_id: str) -> AiConversationModel | None:
        ensure_ai_conversation_schema(self.db)
        return self.db.get(AiConversationModel, conversation_id)

    def get_conversation_for_update(self, conversation_id: str) -> AiConversationModel | None:
        ensure_ai_conversation_schema(self.db)
        return self.db.scalar(
            select(AiConversationModel)
            .where(AiConversationModel.id == conversation_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )

    def list_messages(self, conversation_id: str) -> list[AiConversationMessageModel]:
        ensure_ai_conversation_schema(self.db)
        result = self.db.execute(
            select(AiConversationMessageModel)
            .where(AiConversationMessageModel.conversation_id == conversation_id)
            .order_by(
                AiConversationMessageModel.position.asc(),
                AiConversationMessageModel.id.asc(),
            )
        )
        return list(result.scalars().all())

    def get_message_by_client_request(
        self,
        conversation_id: str,
        client_request_id: str,
    ) -> AiConversationMessageModel | None:
        ensure_ai_conversation_schema(self.db)
        return self.db.scalar(
            select(AiConversationMessageModel).where(
                AiConversationMessageModel.conversation_id == conversation_id,
                AiConversationMessageModel.client_request_id == client_request_id,
            )
        )

    def next_message_position(self, conversation_id: str) -> int:
        ensure_ai_conversation_schema(self.db)
        latest = self.db.scalar(
            select(func.max(AiConversationMessageModel.position)).where(
                AiConversationMessageModel.conversation_id == conversation_id,
            )
        )
        return int(latest or 0) + (1 if latest is not None else 0)

    def add_conversation(self, conversation: AiConversationModel) -> None:
        ensure_ai_conversation_schema(self.db)
        self.db.add(conversation)

    def add_messages(self, *messages: AiConversationMessageModel) -> None:
        ensure_ai_conversation_schema(self.db)
        self.db.add_all(messages)

    def delete_conversation(self, conversation: AiConversationModel) -> None:
        ensure_ai_conversation_schema(self.db)
        self.db.execute(
            delete(AiConversationMessageModel).where(
                AiConversationMessageModel.conversation_id == conversation.id,
            )
        )
        self.db.delete(conversation)
