#!/usr/bin/env python3
"""Generate resumable, bounded-memory synthetic commerce JSONL tiers.

The existing generate.py remains the compatibility entry point for the checked-in
small CSV fixture. V2 accepts a full public product catalog plus a separate
click-eligible pool. This script reuses the behavior helpers and uses per-user
deterministic random streams so a checkpoint can resume without serializing
Python's global RNG state.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import random
import shutil
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from itertools import accumulate
from pathlib import Path
from typing import Any, BinaryIO, Iterable, Sequence
from urllib.parse import quote_plus


MODULE_PATH = Path(__file__).with_name("generate.py")
SPEC = importlib.util.spec_from_file_location("synthetic_generate_core", MODULE_PATH)
assert SPEC and SPEC.loader
core = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = core
SPEC.loader.exec_module(core)


GENERATOR_VERSION = 2
DEFAULT_TIERS = (("1gb", 1_000_000_000), ("5gb", 5_000_000_000), ("10gb", 10_000_000_000))
CHECKPOINT_NAME = "checkpoint.json"
MANIFEST_NAME = "manifest.json"


class GenerationPaused(RuntimeError):
    """Intentional test/manual pause after a durable checkpoint."""


@dataclass
class TierFiles:
    label: str
    target_bytes: int
    users_path: Path
    events_path: Path
    users_handle: BinaryIO
    events_handle: BinaryIO
    state: dict[str, Any]

    def total_bytes(self, product_bytes: int) -> int:
        return product_bytes + int(self.state["user_bytes"]) + int(self.state["event_bytes"])

    def flush(self) -> None:
        for handle in (self.users_handle, self.events_handle):
            handle.flush()
            os.fsync(handle.fileno())

    def close(self) -> None:
        self.users_handle.close()
        self.events_handle.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        help="Amazon metadata JSONL. Required only for legacy --products selection mode.",
    )
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--products", type=int, default=10_000)
    parser.add_argument(
        "--product-catalog",
        type=Path,
        help="Pre-extracted full products.jsonl for v2 generation.",
    )
    parser.add_argument(
        "--click-product-pool",
        type=Path,
        help="Pre-extracted click-eligible product JSONL for v2 generation.",
    )
    parser.add_argument("--seed", type=int, default=20260711)
    parser.add_argument("--start-date", default="2026-06-01")
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument(
        "--tier",
        action="append",
        default=[],
        metavar="LABEL=BYTES",
        help="Repeatable target tier. Sizes accept decimal kb/mb/gb suffixes.",
    )
    parser.add_argument("--checkpoint-every-users", type=int, default=1_000)
    parser.add_argument("--max-users", type=int, default=5_000_000)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--skip-disk-check", action="store_true")
    parser.add_argument(
        "--stop-after-users",
        type=int,
        default=0,
        help="Checkpoint and exit after this many users; intended for recovery verification.",
    )
    return parser.parse_args()


def parse_byte_size(value: str) -> int:
    normalized = value.strip().lower().replace("_", "")
    multipliers = {"kb": 1_000, "mb": 1_000_000, "gb": 1_000_000_000, "b": 1}
    for suffix in ("gb", "mb", "kb", "b"):
        if normalized.endswith(suffix):
            number = normalized[: -len(suffix)]
            break
    else:
        suffix = "b"
        number = normalized
    try:
        parsed = float(number)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid byte size: {value}") from exc
    result = int(parsed * multipliers[suffix])
    if result <= 0:
        raise argparse.ArgumentTypeError(f"byte size must be positive: {value}")
    return result


def parse_tiers(values: Sequence[str]) -> list[tuple[str, int]]:
    tiers = list(DEFAULT_TIERS) if not values else []
    labels: set[str] = set()
    for value in values:
        if "=" not in value:
            raise argparse.ArgumentTypeError(f"tier must use LABEL=BYTES: {value}")
        label, raw_size = value.split("=", 1)
        label = label.strip().lower()
        if not label or not all(character.isalnum() or character in {"-", "_"} for character in label):
            raise argparse.ArgumentTypeError(f"invalid tier label: {label or value}")
        if label in labels:
            raise argparse.ArgumentTypeError(f"duplicate tier label: {label}")
        labels.add(label)
        tiers.append((label, parse_byte_size(raw_size)))
    tiers.sort(key=lambda item: item[1])
    if len({size for _, size in tiers}) != len(tiers):
        raise argparse.ArgumentTypeError("tier byte targets must be unique")
    return tiers


def compact_json_line(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def product_json(product: Any) -> dict[str, Any]:
    return {
        "product_id": product.product_id,
        "category": product.category,
        "leaf_category": product.leaf_category,
        "title": product.title,
        "store": product.store,
        "price": round(float(product.price), 2),
        "average_rating": round(float(product.average_rating), 1),
        "rating_count": int(product.rating_count),
    }


def write_products(path: Path, products: Iterable[Any]) -> int:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as handle:
        for product in products:
            handle.write(compact_json_line(product_json(product)))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    return path.stat().st_size


def load_click_products(path: Path) -> tuple[list[Any], dict[str, Any]]:
    raw_products = []
    seen_ids: set[str] = set()
    category_counts: Counter[str] = Counter()
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            try:
                row = json.loads(line)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise RuntimeError(f"invalid click product JSONL at line {line_number}") from exc
            if not isinstance(row, dict):
                raise RuntimeError(f"click product JSONL line {line_number} must be an object")
            product_id = str(row.get("product_id") or "").strip()
            category = str(row.get("category") or "").strip()
            title = str(row.get("title") or "").strip()
            if not product_id or not category or not title:
                raise RuntimeError(
                    f"click product JSONL line {line_number} is missing product_id, category, or title"
                )
            if product_id in seen_ids:
                raise RuntimeError(f"duplicate click product_id: {product_id}")
            seen_ids.add(product_id)
            try:
                price = float(row["price"])
                average_rating = float(row["average_rating"])
                rating_count = int(row["rating_count"])
            except (KeyError, TypeError, ValueError) as exc:
                raise RuntimeError(
                    f"click product JSONL line {line_number} has invalid price or rating fields"
                ) from exc
            if not 1.0 <= price <= 10_000.0:
                raise RuntimeError(f"click product JSONL line {line_number} has ineligible price")
            if not 1.0 <= average_rating <= 5.0 or rating_count < 5:
                raise RuntimeError(f"click product JSONL line {line_number} has ineligible rating")
            category_counts[category] += 1
            raw_products.append(
                core.Product(
                    product_id=product_id,
                    category=category,
                    leaf_category=str(row.get("leaf_category") or category),
                    title=title,
                    store=str(row.get("store") or ""),
                    price=price,
                    average_rating=average_rating,
                    rating_count=rating_count,
                )
            )
    products = attach_price_percentiles(raw_products)
    behavior_counts = Counter(product.category for product in products)
    missing_categories = [
        category for category in core.TARGET_CATEGORIES if behavior_counts[category] == 0
    ]
    if missing_categories:
        raise RuntimeError(
            "click product pool has no products for behavior categories: "
            + ", ".join(missing_categories)
        )
    return products, {
        "click_pool_rows": len(raw_products),
        "click_pool_by_category": dict(category_counts),
        "behavior_product_rows": len(products),
        "behavior_products_by_category": dict(behavior_counts),
        "unsupported_behavior_category_rows": len(raw_products) - len(products),
        "behavior_categories": list(core.TARGET_CATEGORIES),
    }


def load_products(path: Path) -> list[Any]:
    products, _ = load_click_products(path)
    return products


def attach_price_percentiles(products: Sequence[Any]) -> list[Any]:
    by_category: dict[str, list[Any]] = defaultdict(list)
    for product in products:
        by_category[product.category].append(product)
    result = []
    for category in core.TARGET_CATEGORIES:
        items = sorted(by_category[category], key=lambda item: item.product_id)
        prices = sorted(item.price for item in items)
        price_rank = {price: index for index, price in enumerate(prices)}
        denominator = max(1, len(prices) - 1)
        for item in items:
            result.append(
                core.Product(
                    **{**item.__dict__, "price_percentile": price_rank[item.price] / denominator}
                )
            )
    result.sort(key=lambda item: (item.category, item.product_id))
    return result


def per_user_rng(seed: int, user_index: int, purpose: str) -> random.Random:
    return random.Random(core.stable_hash(seed, f"large:{purpose}:USR-{user_index:09d}"))


def generate_profile(user_index: int, seed: int, start: datetime, end: datetime) -> Any:
    rng = per_user_rng(seed, user_index, "profile")
    bands = ((18, 24), (25, 34), (35, 44), (45, 54), (55, 64), (65, 74))
    low, high = core.weighted_choice(rng, bands, (15, 30, 25, 17, 9, 4))
    age = rng.randint(low, high)
    gender = core.weighted_choice(rng, ("female", "male", "unknown"), (49, 49, 2))
    region = core.weighted_choice(
        rng,
        ("SEOUL", "GYEONGGI", "BUSAN", "INCHEON", "DAEGU", "DAEJEON", "GWANGJU", "OTHER"),
        (35, 28, 10, 8, 6, 5, 4, 4),
    )
    channel = core.weighted_choice(
        rng,
        ("organic", "paid_search", "social", "referral", "affiliate", "email", "direct"),
        (25, 20, 16, 12, 8, 7, 12),
    )
    signup_at = end - timedelta(
        days=rng.randint(2, 730),
        hours=rng.randint(0, 23),
        minutes=rng.randint(0, 59),
    )
    tenure_days = (end - signup_at).days
    membership = core.weighted_choice(
        rng,
        ("basic", "plus", "premium", "vip"),
        (72, 19, 7, 2) if tenure_days < 180 else (58, 25, 12, 5),
    )
    device_weights = (77, 20, 3) if age <= 34 else (48, 44, 8) if age >= 55 else (64, 31, 5)
    primary_device = core.weighted_choice(rng, ("mobile", "desktop", "tablet"), device_weights)
    activity_tier = core.weighted_choice(rng, ("casual", "regular", "power"), (55, 35, 10))
    membership_price_shift = {"basic": 0.12, "plus": 0.02, "premium": -0.08, "vip": -0.15}[membership]
    price_sensitivity = core.clamp(rng.betavariate(2.2, 2.0) + membership_price_shift, 0.02, 0.98)
    purchase_propensity = core.clamp(rng.lognormvariate(-0.05, 0.28), 0.55, 1.7)
    return core.UserProfile(
        public={
            "user_id": f"USR-{user_index:09d}",
            "age": age,
            "gender": gender,
            "region": region,
            "signup_at": signup_at.isoformat(timespec="seconds"),
            "acquisition_channel": channel,
            "membership_tier": membership,
            "primary_device": primary_device,
        },
        activity_tier=activity_tier,
        price_sensitivity=price_sensitivity,
        purchase_propensity=purchase_propensity,
        category_weights=core.make_category_weights(rng, age),
    )


def product_context(products: Sequence[Any]) -> tuple[dict[str, list[Any]], dict[str, list[float]]]:
    by_category: dict[str, list[Any]] = defaultdict(list)
    for product in products:
        by_category[product.category].append(product)
    cumulative_popularity = {
        category: list(
            accumulate(core.product_popularity_weight(product) for product in items)
        )
        for category, items in by_category.items()
    }
    return by_category, cumulative_popularity


def choose_product_large(
    rng: random.Random,
    products: Sequence[Any],
    cumulative_popularity: Sequence[float],
) -> Any:
    if rng.random() < 0.70:
        return rng.choices(products, cum_weights=cumulative_popularity, k=1)[0]
    return rng.choice(products)


def generate_user_events(
    user_index: int,
    profile: Any,
    products_by_category: dict[str, list[Any]],
    cumulative_popularity: dict[str, list[float]],
    seed: int,
    start: datetime,
    end: datetime,
) -> tuple[list[dict[str, Any]], int]:
    rng = per_user_rng(seed, user_index, "events")
    user = profile.public
    eligible_start = max(start, datetime.fromisoformat(user["signup_at"]))
    if eligible_start >= end:
        return [], 0
    session_means = {"casual": 3.0, "regular": 8.0, "power": 20.0}
    membership_cart_multiplier = {"basic": 0.90, "plus": 1.00, "premium": 1.12, "vip": 1.25}
    membership_purchase_multiplier = {"basic": 0.95, "plus": 1.00, "premium": 1.10, "vip": 1.20}
    channel_cart_multiplier = {"referral": 1.12, "email": 1.06, "paid_search": 0.90}
    channel_purchase_multiplier = {"referral": 1.18, "email": 1.08, "paid_search": 0.90}
    events: list[dict[str, Any]] = []
    session_count = core.poisson(rng, session_means[profile.activity_tier])
    local_event_index = 0
    for session_index in range(1, session_count + 1):
        session_id = f"SES-{user_index:09d}-{session_index:04d}"
        device = core.actual_device(rng, user["primary_device"])
        referrer = core.actual_referrer(rng, user["acquisition_channel"])
        span_seconds = max(1, int((end - eligible_start).total_seconds()))
        day_offset = rng.randrange(max(1, math.ceil(span_seconds / 86_400)))
        session_day = min(eligible_start + timedelta(days=day_offset), end - timedelta(seconds=1))
        started_at = session_day.replace(
            hour=core.session_hour(rng, device),
            minute=rng.randint(0, 59),
            second=rng.randint(0, 59),
            microsecond=0,
        )
        if started_at < eligible_start:
            started_at = eligible_start.replace(microsecond=0)
        if started_at >= end:
            started_at = end - timedelta(seconds=1)
        categories = tuple(profile.category_weights)
        category_weights = tuple(profile.category_weights[item] for item in categories)
        impressions = 1 + min(core.poisson(rng, 1.8), 5)
        current_time = started_at
        for position in range(1, impressions + 1):
            category = core.weighted_choice(rng, categories, category_weights)
            product = choose_product_large(
                rng,
                products_by_category[category],
                cumulative_popularity[category],
            )
            current_time += timedelta(seconds=rng.randint(4, 40))

            def emit(event_type: str, page_url: str) -> None:
                nonlocal local_event_index
                local_event_index += 1
                events.append(
                    {
                        "event_id": f"EVT-{user_index:09d}-{local_event_index:05d}",
                        "user_id": user["user_id"],
                        "session_id": session_id,
                        "event_time": current_time.isoformat(timespec="seconds"),
                        "event_type": event_type,
                        "product_id": product.product_id,
                        "page_url": page_url,
                        "device_type": device,
                        "referrer": referrer,
                        "properties": {"position": position},
                    }
                )

            emit("product_impression", f"/search?category={quote_plus(category)}")
            affinity_ratio = profile.category_weights[category] * len(core.TARGET_CATEGORIES)
            click_probability = 0.29 * (0.72 + 0.38 * min(affinity_ratio, 2.6))
            click_probability *= 0.90 + 0.18 * (product.average_rating / 5.0)
            click_probability *= {"mobile": 0.98, "desktop": 1.04, "tablet": 0.95}[device]
            if rng.random() >= core.clamp(click_probability, 0.08, 0.72):
                continue
            current_time += timedelta(seconds=rng.randint(1, 18))
            emit("product_click", f"/dp/{product.product_id}")
            price_factor = 1.22 - profile.price_sensitivity * product.price_percentile * 0.72
            cart_probability = 0.18 * membership_cart_multiplier[user["membership_tier"]]
            cart_probability *= channel_cart_multiplier.get(user["acquisition_channel"], 1.0)
            cart_probability *= price_factor
            if rng.random() >= core.clamp(cart_probability, 0.025, 0.48):
                continue
            current_time += timedelta(seconds=rng.randint(8, 90))
            emit("add_to_cart", f"/dp/{product.product_id}")
            purchase_probability = 0.34 * membership_purchase_multiplier[user["membership_tier"]]
            purchase_probability *= channel_purchase_multiplier.get(user["acquisition_channel"], 1.0)
            purchase_probability *= price_factor * profile.purchase_propensity
            if rng.random() >= core.clamp(purchase_probability, 0.04, 0.72):
                continue
            current_time += timedelta(seconds=rng.randint(15, 150))
            emit("purchase_click", "/checkout")
    return events, session_count


def source_identity(source: Path) -> dict[str, Any]:
    stat = source.stat()
    return {
        "path": str(source.resolve()),
        "name": source.name,
        "bytes": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
    }


def input_file_identity(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "path": str(path.resolve()),
        "name": path.name,
        "bytes": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "sha256": sha256_file(path),
    }


def configuration(
    source: Path | None,
    products: int,
    product_catalog: Path | None,
    click_product_pool: Path | None,
    seed: int,
    start_date: str,
    days: int,
    tiers: Sequence[tuple[str, int]],
) -> dict[str, Any]:
    result = {
        "generator_version": GENERATOR_VERSION,
        "seed": seed,
        "start_date": start_date,
        "days": days,
        "tiers": [{"label": label, "target_bytes": size} for label, size in tiers],
    }
    if product_catalog is not None and click_product_pool is not None:
        result.update(
            {
                "product_mode": "preextracted-v2",
                "product_catalog": input_file_identity(product_catalog),
                "click_product_pool": input_file_identity(click_product_pool),
            }
        )
    else:
        assert source is not None
        result.update(
            {
                "product_mode": "legacy-selection",
                "source": source_identity(source),
                "products": products,
            }
        )
    return result


def initial_tier_state(label: str, target_bytes: int) -> dict[str, Any]:
    return {
        "label": label,
        "target_bytes": target_bytes,
        "complete": False,
        "users": 0,
        "sessions": 0,
        "events": 0,
        "event_type_counts": {},
        "user_bytes": 0,
        "event_bytes": 0,
        "last_bundle_bytes": 0,
    }


def atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def load_checkpoint(path: Path, expected_config: dict[str, Any]) -> dict[str, Any]:
    try:
        checkpoint = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"cannot read checkpoint: {path}") from exc
    if checkpoint.get("configuration") != expected_config:
        raise RuntimeError("checkpoint configuration does not match this generation request")
    return checkpoint


def create_tier_files(output_dir: Path, tier_states: Sequence[dict[str, Any]], resume: bool) -> list[TierFiles]:
    result = []
    try:
        for state in tier_states:
            label = state["label"]
            users_path = output_dir / f"users_{label}.jsonl"
            events_path = output_dir / f"click_events_{label}.jsonl"
            if resume:
                expected_user_bytes = int(state["user_bytes"])
                expected_event_bytes = int(state["event_bytes"])
                if users_path.stat().st_size < expected_user_bytes:
                    raise RuntimeError(
                        f"{users_path.name} is shorter than checkpoint offset"
                    )
                if events_path.stat().st_size < expected_event_bytes:
                    raise RuntimeError(
                        f"{events_path.name} is shorter than checkpoint offset"
                    )
                users_handle = users_path.open("r+b")
                events_handle = events_path.open("r+b")
                users_handle.truncate(expected_user_bytes)
                events_handle.truncate(expected_event_bytes)
                users_handle.seek(expected_user_bytes)
                events_handle.seek(expected_event_bytes)
            else:
                users_handle = users_path.open("w+b")
                events_handle = events_path.open("w+b")
            result.append(
                TierFiles(
                    label=label,
                    target_bytes=int(state["target_bytes"]),
                    users_path=users_path,
                    events_path=events_path,
                    users_handle=users_handle,
                    events_handle=events_handle,
                    state=state,
                )
            )
    except (OSError, RuntimeError):
        for tier in result:
            tier.close()
        raise
    return result


def durable_checkpoint(
    checkpoint_path: Path,
    config: dict[str, Any],
    product_state: dict[str, Any],
    tier_files: Sequence[TierFiles],
    next_user_index: int,
    started_at: str,
    duration_ms: int,
) -> dict[str, Any]:
    for tier in tier_files:
        tier.flush()
        tier.state["user_bytes"] = tier.users_handle.tell()
        tier.state["event_bytes"] = tier.events_handle.tell()
    payload = {
        "checkpoint_version": 1,
        "configuration": config,
        "products": product_state,
        "tiers": [tier.state for tier in tier_files],
        "next_user_index": next_user_index,
        "started_at": started_at,
        "duration_ms": duration_ms,
        "updated_at": datetime.now(tz=core.KST).isoformat(timespec="seconds"),
    }
    atomic_json_write(checkpoint_path, payload)
    return payload


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def scan_product_catalog(path: Path) -> tuple[set[str], dict[str, Any]]:
    product_ids: set[str] = set()
    digest = hashlib.sha256()
    rows = 0
    with path.open("rb") as handle:
        for raw_line in handle:
            rows += 1
            digest.update(raw_line)
            if not raw_line.endswith(b"\n"):
                raise RuntimeError(f"product catalog line {rows} is not newline-terminated")
            try:
                row = json.loads(raw_line)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise RuntimeError(f"invalid product catalog JSONL at line {rows}") from exc
            if not isinstance(row, dict):
                raise RuntimeError(f"product catalog line {rows} must be an object")
            product_id = str(row.get("product_id") or "").strip()
            if not product_id:
                raise RuntimeError(f"product catalog line {rows} has no product_id")
            if product_id in product_ids:
                raise RuntimeError(f"duplicate product catalog product_id: {product_id}")
            product_ids.add(product_id)
    if rows == 0:
        raise RuntimeError("product catalog must not be empty")
    return product_ids, {
        "rows": rows,
        "bytes": path.stat().st_size,
        "sha256": digest.hexdigest(),
    }


def prepare_product_catalog(input_path: Path, output_path: Path) -> tuple[set[str], dict[str, Any]]:
    if input_path.resolve() != output_path.resolve():
        temporary = output_path.with_suffix(output_path.suffix + ".tmp")
        with input_path.open("rb") as source, temporary.open("wb") as target:
            shutil.copyfileobj(source, target, length=4 * 1024 * 1024)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, output_path)
    return scan_product_catalog(output_path)


def assert_click_products_in_catalog(products: Sequence[Any], catalog_ids: set[str]) -> None:
    missing = [product.product_id for product in products if product.product_id not in catalog_ids]
    if missing:
        preview = ", ".join(missing[:5])
        raise RuntimeError(
            f"click product pool references {len(missing)} products absent from catalog: {preview}"
        )


def validate_disk_space(output_dir: Path, tiers: Sequence[tuple[str, int]]) -> None:
    required = int(sum(size for _, size in tiers) * 1.05)
    free = shutil.disk_usage(output_dir).free
    if free < required:
        raise RuntimeError(f"insufficient disk space: required~{required} free={free}")


def cleanup_outputs(
    output_dir: Path, _labels: Sequence[str], *, preserve_products: bool = False
) -> None:
    names = [MANIFEST_NAME, CHECKPOINT_NAME]
    if not preserve_products:
        names.insert(0, "products.jsonl")
    for name in names:
        path = output_dir / name
        if path.exists():
            path.unlink()
    for pattern in ("users_*.jsonl", "click_events_*.jsonl"):
        for path in output_dir.glob(pattern):
            path.unlink()
    for path in output_dir.glob("*.tmp"):
        path.unlink()


def file_metadata(path: Path) -> dict[str, Any]:
    return {"bytes": path.stat().st_size, "sha256": sha256_file(path)}


def build_manifest(
    output_dir: Path,
    checkpoint: dict[str, Any],
    tier_files: Sequence[TierFiles],
) -> dict[str, Any]:
    products_path = output_dir / "products.jsonl"
    product_metadata = file_metadata(products_path)
    tiers = {}
    for tier in tier_files:
        users = file_metadata(tier.users_path)
        events = file_metadata(tier.events_path)
        actual_total = product_metadata["bytes"] + users["bytes"] + events["bytes"]
        target = int(tier.state["target_bytes"])
        allowed_overshoot = max(math.ceil(target * 0.001), int(tier.state["last_bundle_bytes"]))
        tiers[tier.label] = {
            "target_bytes": target,
            "actual_total_bytes": actual_total,
            "overshoot_bytes": actual_total - target,
            "allowed_overshoot_bytes": allowed_overshoot,
            "counts": {
                "products": checkpoint["products"]["count"],
                "users": tier.state["users"],
                "sessions": tier.state["sessions"],
                "events": tier.state["events"],
                "event_type_counts": tier.state["event_type_counts"],
            },
            "files": {
                products_path.name: product_metadata,
                tier.users_path.name: users,
                tier.events_path.name: events,
            },
        }
    return {
        "generator": "generate_large.py",
        "generator_version": GENERATOR_VERSION,
        "status": "complete",
        "configuration": checkpoint["configuration"],
        "product_selection": checkpoint["products"]["selection_stats"],
        "tiers": tiers,
        "started_at": checkpoint["started_at"],
        "completed_at": datetime.now(tz=core.KST).isoformat(timespec="seconds"),
        "duration_ms": int(checkpoint["duration_ms"]),
        "checkpoint_file": CHECKPOINT_NAME,
    }


def run_generation(args: argparse.Namespace) -> dict[str, Any]:
    product_catalog_arg = getattr(args, "product_catalog", None)
    click_product_pool_arg = getattr(args, "click_product_pool", None)
    if bool(product_catalog_arg) != bool(click_product_pool_arg):
        raise RuntimeError("--product-catalog and --click-product-pool must be provided together")
    preextracted_mode = product_catalog_arg is not None
    source_arg = getattr(args, "source", None)
    source = source_arg.resolve() if source_arg is not None else None
    product_catalog = product_catalog_arg.resolve() if product_catalog_arg is not None else None
    click_product_pool = (
        click_product_pool_arg.resolve() if click_product_pool_arg is not None else None
    )
    if preextracted_mode:
        assert product_catalog is not None and click_product_pool is not None
        for label, path in (
            ("product catalog", product_catalog),
            ("click product pool", click_product_pool),
        ):
            if not path.is_file():
                raise RuntimeError(f"{label} does not exist: {path}")
        if product_catalog == click_product_pool:
            raise RuntimeError("product catalog and click product pool must be different files")
    else:
        if source is None or not source.is_file():
            raise RuntimeError(f"source does not exist: {source}")
        if args.products < len(core.TARGET_CATEGORIES):
            raise RuntimeError(f"products must be at least {len(core.TARGET_CATEGORIES)}")
    if args.days <= 0 or args.checkpoint_every_users <= 0 or args.max_users <= 0:
        raise RuntimeError("days, checkpoint-every-users, and max-users must be positive")
    tiers = parse_tiers(args.tier)
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    products_path = output_dir / "products.jsonl"
    if args.force and args.resume:
        raise RuntimeError("--force and --resume cannot be used together")
    if args.force:
        preserve_products = bool(
            product_catalog is not None and product_catalog.resolve() == products_path.resolve()
        )
        cleanup_outputs(
            output_dir,
            [label for label, _ in tiers],
            preserve_products=preserve_products,
        )
    checkpoint_path = output_dir / CHECKPOINT_NAME
    manifest_path = output_dir / MANIFEST_NAME
    config = configuration(
        source,
        args.products,
        product_catalog,
        click_product_pool,
        args.seed,
        args.start_date,
        args.days,
        tiers,
    )
    if not args.resume and checkpoint_path.exists():
        raise RuntimeError(f"checkpoint already exists; use --resume or --force: {checkpoint_path}")
    if not args.resume and manifest_path.exists():
        raise RuntimeError(f"manifest already exists; use --force: {manifest_path}")
    if args.resume and not checkpoint_path.is_file():
        raise RuntimeError(f"checkpoint does not exist: {checkpoint_path}")
    if not args.skip_disk_check and not args.resume:
        validate_disk_space(output_dir, tiers)

    start = datetime.fromisoformat(args.start_date).replace(tzinfo=core.KST)
    end = start + timedelta(days=args.days)
    started_ms = int(time.time() * 1000)
    accumulated_duration_ms = 0
    started_at = datetime.now(tz=core.KST).isoformat(timespec="seconds")
    if args.resume:
        checkpoint = load_checkpoint(checkpoint_path, config)
        product_state = checkpoint["products"]
        if products_path.stat().st_size != int(product_state["bytes"]):
            raise RuntimeError("products.jsonl size does not match checkpoint")
        if sha256_file(products_path) != str(product_state.get("sha256") or ""):
            raise RuntimeError("products.jsonl checksum does not match checkpoint")
        if preextracted_mode:
            assert click_product_pool is not None
            catalog_ids, catalog_metadata = scan_product_catalog(products_path)
            if int(catalog_metadata["rows"]) != int(product_state["count"]):
                raise RuntimeError("products.jsonl row count does not match checkpoint")
            products, _ = load_click_products(click_product_pool)
            assert_click_products_in_catalog(products, catalog_ids)
            del catalog_ids
        else:
            products = load_products(products_path)
        tier_states = checkpoint["tiers"]
        next_user_index = int(checkpoint["next_user_index"])
        started_at = str(checkpoint["started_at"])
        accumulated_duration_ms = int(checkpoint.get("duration_ms") or 0)
    else:
        if preextracted_mode:
            assert product_catalog is not None and click_product_pool is not None
            catalog_ids, catalog_metadata = prepare_product_catalog(
                product_catalog, products_path
            )
            products, click_pool_stats = load_click_products(click_product_pool)
            assert_click_products_in_catalog(products, catalog_ids)
            del catalog_ids
            product_bytes = int(catalog_metadata["bytes"])
            selection_stats = {
                "mode": "preextracted-v2",
                "catalog_rows": int(catalog_metadata["rows"]),
                **click_pool_stats,
            }
            product_count = int(catalog_metadata["rows"])
            product_sha256 = str(catalog_metadata["sha256"])
        else:
            assert source is not None
            products, selection_stats = core.select_products(source, args.products, args.seed)
            product_bytes = write_products(products_path, products)
            # Fresh and resumed runs must build behavior from the exact serialized
            # precision, otherwise price/rating rounding changes later tier hashes.
            products = load_products(products_path)
            product_count = len(products)
            product_sha256 = sha256_file(products_path)
        too_small = [
            label for label, target in tiers if int(target) <= int(product_bytes)
        ]
        if too_small:
            raise RuntimeError(
                "tier target must exceed products.jsonl bytes: "
                + ", ".join(too_small)
            )
        product_state = {
            "path": products_path.name,
            "bytes": product_bytes,
            "sha256": product_sha256,
            "count": product_count,
            "selection_stats": selection_stats,
        }
        tier_states = [initial_tier_state(label, target) for label, target in tiers]
        next_user_index = 1

    if any(int(state["target_bytes"]) <= int(product_state["bytes"]) for state in tier_states):
        raise RuntimeError("tier target must exceed products.jsonl bytes")

    tier_files = create_tier_files(output_dir, tier_states, args.resume)
    products_by_category, popularity = product_context(products)

    def save_checkpoint(user_index: int) -> dict[str, Any]:
        return durable_checkpoint(
            checkpoint_path,
            config,
            product_state,
            tier_files,
            user_index,
            started_at,
            accumulated_duration_ms + int(time.time() * 1000) - started_ms,
        )

    checkpoint = save_checkpoint(next_user_index)
    users_this_run = 0
    try:
        while not all(bool(tier.state["complete"]) for tier in tier_files):
            if next_user_index > args.max_users:
                raise RuntimeError(f"targets were not reached within max-users={args.max_users}")
            profile = generate_profile(next_user_index, args.seed, start, end)
            events, session_count = generate_user_events(
                next_user_index,
                profile,
                products_by_category,
                popularity,
                args.seed,
                start,
                end,
            )
            user_line = compact_json_line(profile.public)
            event_lines = [compact_json_line(event) for event in events]
            event_bytes = sum(len(line) for line in event_lines)
            event_type_counts = Counter(event["event_type"] for event in events)
            for tier in tier_files:
                if tier.state["complete"]:
                    continue
                tier.users_handle.write(user_line)
                tier.events_handle.writelines(event_lines)
                tier.state["users"] += 1
                tier.state["sessions"] += session_count
                tier.state["events"] += len(events)
                tier.state["user_bytes"] = tier.users_handle.tell()
                tier.state["event_bytes"] = tier.events_handle.tell()
                tier.state["last_bundle_bytes"] = len(user_line) + event_bytes
                counts = Counter(tier.state["event_type_counts"])
                counts.update(event_type_counts)
                tier.state["event_type_counts"] = dict(counts)
                if tier.total_bytes(int(product_state["bytes"])) >= tier.target_bytes:
                    tier.state["complete"] = True
            next_user_index += 1
            users_this_run += 1
            should_checkpoint = (
                users_this_run % args.checkpoint_every_users == 0
                or any(tier.state["complete"] and tier.state.get("completed_at") is None for tier in tier_files)
            )
            for tier in tier_files:
                if tier.state["complete"] and tier.state.get("completed_at") is None:
                    tier.state["completed_at"] = datetime.now(tz=core.KST).isoformat(timespec="seconds")
            if should_checkpoint:
                checkpoint = save_checkpoint(next_user_index)
                completed = [tier.label for tier in tier_files if tier.state["complete"]]
                print(
                    json.dumps(
                        {"next_user_index": next_user_index, "completed_tiers": completed},
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            if args.stop_after_users and users_this_run >= args.stop_after_users:
                save_checkpoint(next_user_index)
                raise GenerationPaused(f"paused after {users_this_run} users")
        checkpoint = save_checkpoint(next_user_index)
        manifest = build_manifest(output_dir, checkpoint, tier_files)
        atomic_json_write(manifest_path, manifest)
        checkpoint["status"] = "complete"
        checkpoint["manifest"] = MANIFEST_NAME
        atomic_json_write(checkpoint_path, checkpoint)
        return manifest
    finally:
        for tier in tier_files:
            tier.close()


def main() -> None:
    args = parse_args()
    try:
        manifest = run_generation(args)
    except GenerationPaused as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(75) from exc
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
