from app.repositories.sql_repository import SqlRepository
from app.schemas.sql import QueryRunRequest, QueryRunResponse


class SqlService:
    def __init__(self, repository: SqlRepository) -> None:
        self.repository = repository

    def create_query_run(self, _: QueryRunRequest) -> QueryRunResponse:
        raise NotImplementedError(
            "SQL preview execution will be implemented in the Pair2 SQL API PR."
        )
