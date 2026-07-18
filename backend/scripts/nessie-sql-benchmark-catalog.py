#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.core.database import SessionLocal
from app.models.catalog import CatalogDatasetModel
from app.repositories.catalog_repository import CatalogRepository


SCHEMAS = {
    "customers_v1": [["customer_id", "bigint"], ["segment", "varchar"], ["region", "varchar"], ["signup_date", "date"]],
    "products_v1": [["product_id", "bigint"], ["category", "varchar"], ["list_price", "decimal(12,2)"]],
    "orders_v1": [["order_id", "bigint"], ["customer_id", "bigint"], ["product_id", "bigint"], ["order_date", "date"], ["quantity", "integer"], ["amount", "decimal(14,2)"], ["status", "varchar"]],
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Register or remove synthetic benchmark tables in the local AskLake Catalog")
    parser.add_argument("command", choices=["register", "cleanup"])
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--map-output", type=Path)
    parser.add_argument("--confirm", choices=["REGISTER_SYNTHETIC_BENCHMARK", "REMOVE_SYNTHETIC_BENCHMARK"])
    args = parser.parse_args()
    expected = "REGISTER_SYNTHETIC_BENCHMARK" if args.command == "register" else "REMOVE_SYNTHETIC_BENCHMARK"
    if args.confirm != expected:
        raise SystemExit(f"{args.command} requires --confirm {expected}")
    evidence = json.loads(args.evidence.read_text(encoding="utf-8"))
    dataset_map = {str(table["name"]): f"benchmark_{table['name']}" for table in evidence["tables"]}

    with SessionLocal() as db:
        repository = CatalogRepository(db)
        if args.command == "register":
            for table in evidence["tables"]:
                name = str(table["name"])
                dataset_id = dataset_map[name]
                repository.save_dataset_payload({
                    "id": dataset_id,
                    "name": name,
                    "description": "Synthetic Nessie SQL benchmark fixture",
                    "owner": "Benchmark Admin",
                    "layer": "GOLD",
                    "status": "available",
                    "freshness": "latest",
                    "source": "Issue #961 deterministic synthetic fixture",
                    "rows": str(table["rowCount"]),
                    "size": str(table["storageBytes"]),
                    "storageSizeBytes": table["storageBytes"],
                    "quality": "verified synthetic fixture",
                    "lastUpdated": "fixture-v1",
                    "nextRefresh": "manual",
                    "rag": False,
                    "tags": ["benchmark", "synthetic"],
                    "schema": SCHEMAS[name],
                    "sampleRows": [],
                    "upstream": [],
                    "downstream": [],
                    "queryEngineStatus": "available",
                    "queryEngineTable": {"catalog": evidence["catalog"], "schema": evidence["schema"], "table": name, "format": "iceberg", "partitionColumns": ["order_date"] if name == "orders_v1" else []},
                    "partition": "month(order_date)" if name == "orders_v1" else None,
                    "partitionColumns": ["order_date"] if name == "orders_v1" else [],
                    "icebergSnapshotId": str(table["snapshotId"]),
                    "schemaFingerprint": evidence["manifestHash"],
                    "estimatedRowCount": table["rowCount"],
                    "uniqueKeyColumns": [SCHEMAS[name][0][0]],
                    "indexColumns": [SCHEMAS[name][0][0]],
                    "indexColumnsUnique": True,
                })
            if args.map_output is None:
                raise SystemExit("register requires --map-output")
            if args.map_output.exists():
                raise SystemExit("Dataset map output already exists")
            args.map_output.parent.mkdir(parents=True, exist_ok=True)
            args.map_output.write_text(json.dumps(dataset_map, indent=2) + "\n", encoding="utf-8")
        else:
            for dataset_id in dataset_map.values():
                model = db.get(CatalogDatasetModel, dataset_id)
                if model is not None:
                    db.delete(model)
            db.commit()
    print(json.dumps({"command": args.command, "datasets": len(dataset_map)}, indent=2))


if __name__ == "__main__":
    main()
