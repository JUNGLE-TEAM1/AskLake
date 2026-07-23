from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Iterable

from sqlglot import exp, parse_one
from sqlglot.errors import ParseError

from app.schemas.catalog import CatalogDatasetResponse
from app.services.sql_service import build_dataset_context_map, normalize_sql_identifier


QUERY_AI_JOIN_CONTRACT_VERSION = "join-aware-v3"

_JOIN_REQUEST_PATTERN = re.compile(
    r"(?<![0-9a-z_])join(?![0-9a-z_])|조인|결합|합쳐|합친|합쳐서|연결|매칭|매치|붙여",
    re.IGNORECASE,
)
_GENERIC_ENTITY_TOKENS = {
    "archive",
    "bronze",
    "catalog",
    "data",
    "dataset",
    "dim",
    "dimension",
    "ds",
    "fact",
    "facts",
    "gold",
    "master",
    "raw",
    "silver",
    "table",
}
_STRING_TYPES = {"char", "character", "json", "string", "text", "uuid", "varchar"}
_INTEGER_TYPES = {"bigint", "byteint", "int", "integer", "long", "short", "smallint", "tinyint"}
_NUMERIC_TYPES = {"decimal", "double", "float", "number", "numeric", "real"}


@dataclass(frozen=True)
class JoinColumnPair:
    left_column: str
    right_column: str


@dataclass(frozen=True)
class JoinRelationship:
    left_dataset_id: str
    right_dataset_id: str
    pairs: tuple[JoinColumnPair, ...]
    relationship_type: str
    source: str

    def canonical_signature(self) -> tuple[tuple[tuple[str, str], tuple[str, str]], ...]:
        return canonical_join_signature(
            (
                self.left_dataset_id,
                pair.left_column,
                self.right_dataset_id,
                pair.right_column,
            )
            for pair in self.pairs
        )


@dataclass(frozen=True)
class QueryJoinPlan:
    relationships: tuple[JoinRelationship, ...]
    version: str = QUERY_AI_JOIN_CONTRACT_VERSION

    @property
    def signatures(self) -> set[tuple[tuple[tuple[str, str], tuple[str, str]], ...]]:
        return {relationship.canonical_signature() for relationship in self.relationships}


@dataclass(frozen=True)
class QueryJoinAnalysis:
    violations: tuple[str, ...]
    used_relationships: tuple[JoinRelationship, ...]


def build_query_join_plan(
    datasets: list[CatalogDatasetResponse],
    rag_context: dict[str, Any] | None,
) -> QueryJoinPlan:
    relationships = [
        *_semantic_relationships(datasets, rag_context),
        *_catalog_key_relationships(datasets),
    ]
    unique: dict[
        tuple[tuple[tuple[str, str], tuple[str, str]], ...],
        JoinRelationship,
    ] = {}
    # Published semantic relationships are appended first and therefore win
    # over a schema-derived Catalog key candidate with the same key pairs.
    for relationship in relationships:
        unique.setdefault(relationship.canonical_signature(), relationship)
    return QueryJoinPlan(relationships=tuple(unique.values()))


def prompt_requests_join(prompt: str, datasets: list[CatalogDatasetResponse]) -> bool:
    if len(datasets) < 2:
        return False
    normalized_prompt = " ".join(str(prompt or "").casefold().split())
    if _JOIN_REQUEST_PATTERN.search(normalized_prompt):
        return True

    # Exact SQL-like column names are common in analyst prompts. If the prompt
    # asks for columns that uniquely belong to two selected Datasets, a join is
    # required even when the user did not literally say "JOIN".
    column_owners: dict[str, set[str]] = {}
    for dataset in datasets:
        for column_name, _type_name in dataset.schema_:
            normalized_column = normalize_sql_identifier(column_name)
            if len(normalized_column) >= 3:
                column_owners.setdefault(normalized_column, set()).add(dataset.id)
    explicitly_referenced_owners = {
        next(iter(owners))
        for column_name, owners in column_owners.items()
        if len(owners) == 1 and _contains_prompt_token(normalized_prompt, column_name)
    }
    cross_dataset_analysis_marker = re.search(
        r"별|기준|같이|함께|동시에|\bby\b|\bper\b|\bwith\b",
        normalized_prompt,
    )
    return bool(cross_dataset_analysis_marker and len(explicitly_referenced_owners) >= 2)


def join_context_lines(plan: QueryJoinPlan, datasets: list[CatalogDatasetResponse]) -> list[str]:
    dataset_by_id = {dataset.id: dataset for dataset in datasets}
    lines = [f"JOIN relationship context version: {plan.version}"]
    if not plan.relationships:
        lines.append(
            "- allowedRelationships=none; 선택 데이터셋 사이에 검증 가능한 JOIN key가 없습니다. "
            "JOIN key를 추측하거나 임의로 만들지 마세요."
        )
        return lines
    lines.append(
        "- 아래 allowedRelationship만 JOIN ON에 사용할 수 있습니다. 별칭을 써도 Dataset과 column 쌍은 정확히 같아야 합니다."
    )
    for relationship in plan.relationships:
        left = dataset_by_id[relationship.left_dataset_id]
        right = dataset_by_id[relationship.right_dataset_id]
        predicates = " AND ".join(
            f"{_quote_trino_identifier(left.name)}.{_quote_trino_identifier(pair.left_column)} = "
            f"{_quote_trino_identifier(right.name)}.{_quote_trino_identifier(pair.right_column)}"
            for pair in relationship.pairs
        )
        lines.append(
            f"- allowedRelationship source={relationship.source}; cardinality={relationship.relationship_type}; "
            f"datasets={left.id}<->{right.id}; ON {predicates}"
        )
    return lines


def validate_query_join_contract(
    statement: str,
    *,
    datasets: list[CatalogDatasetResponse],
    plan: QueryJoinPlan,
    join_required: bool,
) -> list[str]:
    return list(_analyze_query_join_contract(
        statement,
        datasets=datasets,
        plan=plan,
        join_required=join_required,
    ).violations)


def used_join_evidence(
    statement: str,
    *,
    datasets: list[CatalogDatasetResponse],
    plan: QueryJoinPlan,
) -> list[dict[str, Any]]:
    analysis = _analyze_query_join_contract(
        statement,
        datasets=datasets,
        plan=plan,
        join_required=False,
    )
    if analysis.violations:
        return []
    dataset_by_id = {dataset.id: dataset for dataset in datasets}
    return [
        {
            "source": relationship.source,
            "relationshipType": relationship.relationship_type,
            "leftDatasetId": relationship.left_dataset_id,
            "leftDatasetName": dataset_by_id[relationship.left_dataset_id].name,
            "rightDatasetId": relationship.right_dataset_id,
            "rightDatasetName": dataset_by_id[relationship.right_dataset_id].name,
            "columnPairs": [
                {
                    "leftColumn": pair.left_column,
                    "rightColumn": pair.right_column,
                }
                for pair in relationship.pairs
            ],
        }
        for relationship in analysis.used_relationships
    ]


def _analyze_query_join_contract(
    statement: str,
    *,
    datasets: list[CatalogDatasetResponse],
    plan: QueryJoinPlan,
    join_required: bool,
) -> QueryJoinAnalysis:
    try:
        expression = parse_one(statement, read="trino")
    except ParseError:
        return QueryJoinAnalysis(("invalid_trino_sql",), ())

    joins = list(expression.find_all(exp.Join))
    if join_required and not joins:
        return QueryJoinAnalysis(("join_required_but_missing",), ())
    if not joins:
        return QueryJoinAnalysis((), ())

    violations: list[str] = []
    dataset_context = build_dataset_context_map(datasets)
    cte_names = {
        normalize_sql_identifier(cte.alias_or_name)
        for cte in expression.find_all(exp.CTE)
        if cte.alias_or_name
    }
    relationship_by_signature = {
        relationship.canonical_signature(): relationship
        for relationship in plan.relationships
    }
    used_relationships: dict[
        tuple[tuple[tuple[str, str], tuple[str, str]], ...],
        JoinRelationship,
    ] = {}

    for select in expression.find_all(exp.Select):
        direct_joins = [
            join
            for join in (select.args.get("joins") or [])
            if isinstance(join, exp.Join)
        ]
        if not direct_joins:
            continue
        from_clause = select.args.get("from_")
        base_source = from_clause.this if isinstance(from_clause, exp.From) else None
        base_binding = _table_binding(base_source, dataset_context, cte_names)
        if base_binding is None:
            violations.append("join_source_not_catalog_dataset")
            continue
        alias_datasets: dict[str, CatalogDatasetResponse] = {base_binding[0]: base_binding[1]}
        left_aliases = {base_binding[0]}

        for join in direct_joins:
            right_binding = _table_binding(join.this, dataset_context, cte_names)
            if right_binding is None:
                violations.append("join_target_not_catalog_dataset")
                continue
            right_alias, right_dataset = right_binding
            if right_alias in alias_datasets:
                violations.append(f"join_alias_reused:{right_alias}")
                continue
            alias_datasets[right_alias] = right_dataset

            if str(join.args.get("kind") or "").casefold() == "cross":
                violations.append("cross_join")
                left_aliases.add(right_alias)
                continue
            if join.args.get("using") is not None:
                violations.append("join_using_not_allowed")
                left_aliases.add(right_alias)
                continue
            on_expression = join.args.get("on")
            predicates = _equality_predicates(on_expression)
            if predicates is None:
                violations.append("join_predicate_must_be_column_equality")
                left_aliases.add(right_alias)
                continue

            actual_pairs: list[tuple[str, str, str, str]] = []
            predicate_failed = False
            for predicate in predicates:
                first = predicate.this
                second = predicate.expression
                assert isinstance(first, exp.Column) and isinstance(second, exp.Column)
                resolved_first = _resolve_join_column(first, alias_datasets)
                resolved_second = _resolve_join_column(second, alias_datasets)
                if isinstance(resolved_first, str):
                    violations.append(resolved_first)
                    predicate_failed = True
                    continue
                if isinstance(resolved_second, str):
                    violations.append(resolved_second)
                    predicate_failed = True
                    continue
                first_alias, first_dataset, first_name, first_type = resolved_first
                second_alias, second_dataset, second_name, second_type = resolved_second
                if not (
                    (first_alias == right_alias and second_alias in left_aliases)
                    or (second_alias == right_alias and first_alias in left_aliases)
                ):
                    violations.append("join_key_does_not_connect_current_inputs")
                    predicate_failed = True
                    continue
                if not compatible_join_types(first_type, second_type):
                    violations.append(
                        f"join_key_type_mismatch:{first_alias}.{first_name}:{second_alias}.{second_name}"
                    )
                    predicate_failed = True
                    continue
                actual_pairs.append(
                    (first_dataset.id, first_name, second_dataset.id, second_name)
                )

            if not predicate_failed:
                signature = canonical_join_signature(actual_pairs)
                relationship = relationship_by_signature.get(signature)
                if relationship is None:
                    violations.append("join_relationship_not_allowed")
                else:
                    used_relationships.setdefault(signature, relationship)
            left_aliases.add(right_alias)

    return QueryJoinAnalysis(
        tuple(dict.fromkeys(violations)),
        tuple(used_relationships.values()),
    )


def canonical_join_signature(
    pairs: Iterable[tuple[str, str, str, str]],
) -> tuple[tuple[tuple[str, str], tuple[str, str]], ...]:
    normalized_pairs = []
    for left_dataset_id, left_column, right_dataset_id, right_column in pairs:
        first = (str(left_dataset_id), normalize_sql_identifier(left_column))
        second = (str(right_dataset_id), normalize_sql_identifier(right_column))
        normalized_pairs.append(tuple(sorted((first, second))))
    return tuple(sorted(set(normalized_pairs)))


def compatible_join_types(left: str, right: str) -> bool:
    left_family = _type_family(left)
    right_family = _type_family(right)
    return bool(left_family and left_family == right_family)


def _semantic_relationships(
    datasets: list[CatalogDatasetResponse],
    rag_context: dict[str, Any] | None,
) -> list[JoinRelationship]:
    if not isinstance(rag_context, dict):
        return []
    retrieval = rag_context.get("retrieval")
    if not isinstance(retrieval, dict):
        return []
    semantic_models = retrieval.get("semanticModels")
    if not isinstance(semantic_models, list):
        return []
    dataset_by_id = {dataset.id: dataset for dataset in datasets}
    relationships: list[JoinRelationship] = []
    for model in semantic_models:
        if not isinstance(model, dict):
            continue
        model_id = str(model.get("id") or "unknown")
        model_version = str(model.get("version") or "unknown")
        for item in model.get("relationships") or []:
            if not isinstance(item, dict):
                continue
            left = dataset_by_id.get(str(item.get("fromDatasetId") or ""))
            right = dataset_by_id.get(str(item.get("toDatasetId") or ""))
            if left is None or right is None or left.id == right.id:
                continue
            pairs = _parse_semantic_join_expression(
                str(item.get("joinExpression") or ""),
                left,
                right,
            )
            if not pairs:
                continue
            relationships.append(JoinRelationship(
                left_dataset_id=left.id,
                right_dataset_id=right.id,
                pairs=pairs,
                relationship_type=str(item.get("relationshipType") or "related"),
                source=f"semantic_model:{model_id}@{model_version}",
            ))
    return relationships


def _catalog_key_relationships(
    datasets: list[CatalogDatasetResponse],
) -> list[JoinRelationship]:
    relationships: list[JoinRelationship] = []
    for unique_dataset in datasets:
        for key_set in verified_unique_key_sets(unique_dataset):
            for other_dataset in datasets:
                if other_dataset.id == unique_dataset.id:
                    continue
                pairs = _match_foreign_key_columns(other_dataset, unique_dataset, key_set)
                if not pairs:
                    continue
                relationships.append(JoinRelationship(
                    left_dataset_id=other_dataset.id,
                    right_dataset_id=unique_dataset.id,
                    pairs=pairs,
                    relationship_type="many_to_one",
                    source="catalog_unique_key",
                ))
    return relationships


def verified_unique_key_sets(dataset: CatalogDatasetResponse) -> list[tuple[str, ...]]:
    candidates = [tuple(item) for item in dataset.unique_key_sets if item]
    if dataset.unique_key_columns:
        candidates.append(tuple(dataset.unique_key_columns))
    if dataset.index_columns_unique and dataset.index_columns:
        candidates.append(tuple(dataset.index_columns))
    schema_names = {normalize_sql_identifier(name): name for name, _type_name in dataset.schema_}
    unique: dict[tuple[str, ...], tuple[str, ...]] = {}
    for candidate in candidates:
        normalized = tuple(normalize_sql_identifier(name) for name in candidate)
        if not normalized or len(set(normalized)) != len(normalized):
            continue
        if any(name not in schema_names for name in normalized):
            continue
        unique.setdefault(normalized, tuple(schema_names[name] for name in normalized))
    return list(unique.values())


def _match_foreign_key_columns(
    foreign_dataset: CatalogDatasetResponse,
    unique_dataset: CatalogDatasetResponse,
    unique_key_set: tuple[str, ...],
) -> tuple[JoinColumnPair, ...]:
    foreign_schema = {
        normalize_sql_identifier(name): (name, type_name)
        for name, type_name in foreign_dataset.schema_
    }
    unique_schema = {
        normalize_sql_identifier(name): (name, type_name)
        for name, type_name in unique_dataset.schema_
    }
    pairs: list[JoinColumnPair] = []
    for unique_column in unique_key_set:
        normalized_unique = normalize_sql_identifier(unique_column)
        target = foreign_schema.get(normalized_unique)
        if target is None and len(unique_key_set) == 1 and normalized_unique == "id":
            for namespaced_name in _entity_key_names(unique_dataset):
                if namespaced_name in foreign_schema:
                    target = foreign_schema[namespaced_name]
                    break
        if target is None:
            return ()
        unique_item = unique_schema.get(normalized_unique)
        if unique_item is None or not compatible_join_types(target[1], unique_item[1]):
            return ()
        # A bare id=id match between unrelated datasets is too ambiguous. It
        # is accepted only as one member of a composite key; a single-column
        # relation needs an entity-qualified foreign key such as user_id.
        if len(unique_key_set) == 1 and normalized_unique == "id" and normalize_sql_identifier(target[0]) == "id":
            return ()
        pairs.append(JoinColumnPair(left_column=target[0], right_column=unique_item[0]))
    return tuple(pairs)


def _parse_semantic_join_expression(
    join_expression: str,
    left: CatalogDatasetResponse,
    right: CatalogDatasetResponse,
) -> tuple[JoinColumnPair, ...]:
    try:
        expression = parse_one(join_expression, read="trino")
    except ParseError:
        return ()
    predicates = _equality_predicates(expression)
    if predicates is None:
        return ()
    pairs: list[JoinColumnPair] = []
    for predicate in predicates:
        first = predicate.this
        second = predicate.expression
        assert isinstance(first, exp.Column) and isinstance(second, exp.Column)
        resolved_first = _resolve_semantic_column(first, left, right)
        resolved_second = _resolve_semantic_column(second, left, right)
        if resolved_first is None or resolved_second is None:
            return ()
        first_dataset, first_name, first_type = resolved_first
        second_dataset, second_name, second_type = resolved_second
        if first_dataset.id == second_dataset.id or not compatible_join_types(first_type, second_type):
            return ()
        if first_dataset.id == left.id:
            pairs.append(JoinColumnPair(first_name, second_name))
        else:
            pairs.append(JoinColumnPair(second_name, first_name))
    return tuple(pairs)


def _resolve_semantic_column(
    column: exp.Column,
    left: CatalogDatasetResponse,
    right: CatalogDatasetResponse,
) -> tuple[CatalogDatasetResponse, str, str] | None:
    normalized_column = normalize_sql_identifier(column.name)
    if not normalized_column:
        return None
    qualifier = normalize_sql_identifier(column.table) if column.table else ""
    if qualifier:
        matches = [
            dataset
            for dataset in (left, right)
            if qualifier in {
                normalize_sql_identifier(dataset.id),
                normalize_sql_identifier(dataset.name),
            }
        ]
        if not matches:
            alias_mapping = {"left": left, "source": left, "from_dataset": left, "right": right, "lookup": right, "to_dataset": right}
            dataset = alias_mapping.get(qualifier)
            matches = [dataset] if dataset is not None else []
    else:
        matches = [
            dataset
            for dataset in (left, right)
            if normalized_column in _schema_by_name(dataset)
        ]
    if len(matches) != 1:
        return None
    dataset = matches[0]
    schema_item = _schema_by_name(dataset).get(normalized_column)
    if schema_item is None:
        return None
    return dataset, schema_item[0], schema_item[1]


def _table_binding(
    source: exp.Expression | None,
    dataset_context: dict[str, CatalogDatasetResponse],
    cte_names: set[str],
) -> tuple[str, CatalogDatasetResponse] | None:
    if not isinstance(source, exp.Table):
        return None
    table_name = normalize_sql_identifier(source.name)
    if not source.db and not source.catalog and table_name in cte_names:
        return None
    if source.db or source.catalog:
        qualified = normalize_sql_identifier(".".join(filter(None, (source.catalog, source.db, source.name))))
        dataset = dataset_context.get(qualified) or dataset_context.get(table_name)
    else:
        dataset = dataset_context.get(table_name)
    if dataset is None:
        return None
    alias = normalize_sql_identifier(source.alias_or_name or source.name)
    return (alias, dataset) if alias else None


def _resolve_join_column(
    column: exp.Column,
    alias_datasets: dict[str, CatalogDatasetResponse],
) -> tuple[str, CatalogDatasetResponse, str, str] | str:
    column_name = normalize_sql_identifier(column.name)
    if not column_name:
        return "join_column_not_found"
    if not column.table:
        return f"join_column_unqualified:{column.name}"
    alias = normalize_sql_identifier(column.table)
    dataset = alias_datasets.get(alias)
    if dataset is None:
        return f"join_alias_unknown:{column.table}"
    schema_item = _schema_by_name(dataset).get(column_name)
    if schema_item is None:
        return f"join_column_not_found:{column.table}.{column.name}"
    return alias, dataset, schema_item[0], schema_item[1]


def _equality_predicates(expression: exp.Expression | None) -> list[exp.EQ] | None:
    if expression is None:
        return None
    flattened: list[exp.Expression] = []

    def visit(node: exp.Expression) -> None:
        if isinstance(node, exp.Paren):
            visit(node.this)
        elif isinstance(node, exp.And):
            visit(node.this)
            visit(node.expression)
        else:
            flattened.append(node)

    visit(expression)
    if not flattened or any(
        not isinstance(item, exp.EQ)
        or not isinstance(item.this, exp.Column)
        or not isinstance(item.expression, exp.Column)
        for item in flattened
    ):
        return None
    return [item for item in flattened if isinstance(item, exp.EQ)]


def _schema_by_name(dataset: CatalogDatasetResponse) -> dict[str, tuple[str, str]]:
    return {
        normalize_sql_identifier(name): (name, type_name)
        for name, type_name in dataset.schema_
    }


def _entity_key_names(dataset: CatalogDatasetResponse) -> list[str]:
    tokens: list[str] = []
    for value in (dataset.name, dataset.id):
        for token in re.findall(r"[0-9a-z]+", str(value).casefold()):
            if token in _GENERIC_ENTITY_TOKENS or re.fullmatch(r"v?\d+", token):
                continue
            singular = _singularize(token)
            if singular and singular not in tokens:
                tokens.append(singular)
    return [f"{token}_id" for token in reversed(tokens)]


def _singularize(token: str) -> str:
    if token.endswith("ies") and len(token) > 3:
        return f"{token[:-3]}y"
    if token.endswith("ses") and len(token) > 3:
        return token[:-2]
    if token.endswith("s") and not token.endswith("ss") and len(token) > 2:
        return token[:-1]
    return token


def _contains_prompt_token(prompt: str, token: str) -> bool:
    if not token:
        return False
    if re.fullmatch(r"[0-9a-z_]+", token):
        return re.search(rf"(?<![0-9a-z_]){re.escape(token)}(?![0-9a-z_])", prompt) is not None
    return token in prompt


def _type_family(type_name: str) -> str:
    normalized = re.sub(r"\s+", "", str(type_name or "").casefold())
    base = normalized.split("(", 1)[0]
    if base in _STRING_TYPES or base.startswith(("varchar", "char")):
        return "string"
    if base in _INTEGER_TYPES:
        return "integer"
    if base in _NUMERIC_TYPES:
        return "numeric"
    if base in {"date"}:
        return "date"
    if base.startswith("timestamp") or base in {"datetime"}:
        return "timestamp"
    if base in {"bool", "boolean"}:
        return "boolean"
    return base


def _quote_trino_identifier(identifier: str) -> str:
    escaped = str(identifier).replace('"', '""')
    return f'"{escaped}"'
