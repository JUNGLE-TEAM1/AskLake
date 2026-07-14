#!/usr/bin/env python3
"""Generate a small, deterministic commerce dataset from Amazon metadata.

The generator intentionally separates stable user attributes from hidden behavior
traits.  Hidden traits influence sessions and funnel transitions but are not
written to users.csv, so downstream SQL still has to discover the planted
patterns instead of reading the answer directly.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import heapq
import json
import math
import random
import sqlite3
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence
from urllib.parse import quote_plus


KST = timezone(timedelta(hours=9))

TARGET_CATEGORIES = (
    "Computers & Accessories",
    "Camera & Photo",
    "Television & Video",
    "Headphones, Earbuds & Accessories",
    "Home Audio",
    "Car & Vehicle Electronics",
    "Portable Audio & Video",
    "Wearable Technology",
)

USER_COLUMNS = (
    "user_id",
    "age",
    "gender",
    "region",
    "signup_at",
    "acquisition_channel",
    "membership_tier",
    "primary_device",
)

PRODUCT_COLUMNS = (
    "product_id",
    "category",
    "leaf_category",
    "title",
    "store",
    "price",
    "average_rating",
    "rating_count",
)


@dataclass(frozen=True)
class Product:
    product_id: str
    category: str
    leaf_category: str
    title: str
    store: str
    price: float
    average_rating: float
    rating_count: int
    price_percentile: float = 0.5

    def as_csv_row(self) -> dict[str, Any]:
        return {
            "product_id": self.product_id,
            "category": self.category,
            "leaf_category": self.leaf_category,
            "title": self.title,
            "store": self.store,
            "price": f"{self.price:.2f}",
            "average_rating": f"{self.average_rating:.1f}",
            "rating_count": self.rating_count,
        }


@dataclass
class UserProfile:
    public: dict[str, Any]
    activity_tier: str
    price_sensitivity: float
    purchase_propensity: float
    category_weights: dict[str, float]


class DiskBackedIdTracker:
    """Track exact source IDs without retaining the source cardinality in RAM."""

    def __enter__(self) -> "DiskBackedIdTracker":
        self._directory = tempfile.TemporaryDirectory(prefix="asklake-product-ids-")
        database = Path(self._directory.name) / "seen.sqlite"
        self._connection = sqlite3.connect(database)
        self._connection.execute("PRAGMA journal_mode=OFF")
        self._connection.execute("PRAGMA synchronous=OFF")
        self._connection.execute("PRAGMA temp_store=FILE")
        self._connection.execute(
            "CREATE TABLE seen (product_id TEXT PRIMARY KEY) WITHOUT ROWID"
        )
        return self

    def seen_before(self, product_id: str) -> bool:
        before = self._connection.total_changes
        self._connection.execute(
            "INSERT OR IGNORE INTO seen(product_id) VALUES (?)", (product_id,)
        )
        return self._connection.total_changes == before

    def __exit__(self, *_args: object) -> None:
        self._connection.close()
        self._directory.cleanup()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--products", type=int, default=10_000)
    parser.add_argument("--users", type=int, default=3_000)
    parser.add_argument("--seed", type=int, default=20260711)
    parser.add_argument("--start-date", default="2026-06-01")
    parser.add_argument("--days", type=int, default=30)
    return parser.parse_args()


def stable_hash(seed: int, value: str) -> int:
    payload = f"{seed}:{value}".encode("utf-8")
    return int.from_bytes(hashlib.blake2b(payload, digest_size=8).digest(), "big")


def safe_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        cleaned = value.replace("$", "").replace(",", "").strip()
        try:
            number = float(cleaned)
        except ValueError:
            return None
    else:
        return None
    return number if math.isfinite(number) else None


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def poisson(rng: random.Random, mean: float) -> int:
    """Knuth Poisson sampler; sufficient for the small means used here."""
    limit = math.exp(-mean)
    product = 1.0
    count = 0
    while product > limit:
        count += 1
        product *= rng.random()
    return count - 1


def weighted_choice(rng: random.Random, values: Sequence[Any], weights: Sequence[float]) -> Any:
    return rng.choices(values, weights=weights, k=1)[0]


def select_products(source: Path, count: int, seed: int) -> tuple[list[Product], dict[str, Any]]:
    if count < len(TARGET_CATEGORIES):
        raise ValueError(f"products must be at least {len(TARGET_CATEGORIES)}")

    base_quota, remainder = divmod(count, len(TARGET_CATEGORIES))
    quotas = {
        category: base_quota + (1 if index < remainder else 0)
        for index, category in enumerate(TARGET_CATEGORIES)
    }
    heaps: dict[str, list[tuple[int, str, Product]]] = {category: [] for category in TARGET_CATEGORIES}
    selected_ids: dict[str, set[str]] = {category: set() for category in TARGET_CATEGORIES}
    scan = Counter()

    with DiskBackedIdTracker() as seen_eligible_ids, source.open("r", encoding="utf-8") as handle:
        for line in handle:
            scan["source_rows"] += 1
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                scan["invalid_json"] += 1
                continue

            categories = raw.get("categories") or []
            category = categories[1] if len(categories) > 1 else None
            if category not in quotas:
                scan["unsupported_or_missing_category"] += 1
                continue

            product_id = str(raw.get("parent_asin") or "").strip()
            title = str(raw.get("title") or "").strip()
            price = safe_float(raw.get("price"))
            rating = safe_float(raw.get("average_rating"))
            rating_count = raw.get("rating_number")
            try:
                rating_count = int(rating_count)
            except (TypeError, ValueError):
                rating_count = 0

            if not product_id or not title:
                scan["missing_identity"] += 1
                continue
            if price is None or not 1.0 <= price <= 10_000.0:
                scan["invalid_price"] += 1
                continue
            if rating is None or not 1.0 <= rating <= 5.0 or rating_count < 5:
                scan["insufficient_rating_evidence"] += 1
                continue
            if seen_eligible_ids.seen_before(product_id):
                scan["duplicate_product_id"] += 1
                continue

            scan[f"eligible::{category}"] += 1
            product = Product(
                product_id=product_id,
                category=category,
                leaf_category=str(categories[-1] if categories else category),
                title=title,
                store=str(raw.get("store") or "Unknown").strip() or "Unknown",
                price=price,
                average_rating=rating,
                rating_count=rating_count,
            )
            score = stable_hash(seed, product_id)
            heap = heaps[category]
            if product_id in selected_ids[category]:
                continue
            entry = (-score, product_id, product)
            if len(heap) < quotas[category]:
                heapq.heappush(heap, entry)
                selected_ids[category].add(product_id)
            elif score < -heap[0][0]:
                removed = heapq.heapreplace(heap, entry)
                selected_ids[category].remove(removed[1])
                selected_ids[category].add(product_id)

    products: list[Product] = []
    for category in TARGET_CATEGORIES:
        selected = [entry[2] for entry in heaps[category]]
        if len(selected) != quotas[category]:
            raise RuntimeError(
                f"not enough eligible products for {category}: "
                f"needed {quotas[category]}, found {len(selected)}"
            )
        selected.sort(key=lambda item: item.product_id)
        prices = sorted(item.price for item in selected)
        price_rank = {price: index for index, price in enumerate(prices)}
        denominator = max(1, len(prices) - 1)
        for item in selected:
            products.append(
                Product(
                    **{**item.__dict__, "price_percentile": price_rank[item.price] / denominator}
                )
            )

    products.sort(key=lambda item: (item.category, item.product_id))
    stats = {
        "source_rows_scanned": scan["source_rows"],
        "invalid_json_rows": scan["invalid_json"],
        "unsupported_or_missing_category_rows": scan["unsupported_or_missing_category"],
        "missing_identity_rows": scan["missing_identity"],
        "invalid_price_rows": scan["invalid_price"],
        "insufficient_rating_evidence_rows": scan["insufficient_rating_evidence"],
        "duplicate_product_id_rows": scan["duplicate_product_id"],
        "eligible_rows": sum(scan[f"eligible::{category}"] for category in TARGET_CATEGORIES),
        "selected_rows": len(products),
        "selected_by_category": dict(Counter(item.category for item in products)),
        "eligible_by_category": {
            category: scan[f"eligible::{category}"] for category in TARGET_CATEGORIES
        },
        "selection_rule": "balanced deterministic hash sample; valid price; rating_count >= 5",
    }
    return products, stats


def age_band(age: int) -> str:
    if age <= 24:
        return "18-24"
    if age <= 34:
        return "25-34"
    if age <= 44:
        return "35-44"
    if age <= 54:
        return "45-54"
    if age <= 64:
        return "55-64"
    return "65-74"


def make_category_weights(rng: random.Random, age: int) -> dict[str, float]:
    weights = {category: 1.0 for category in TARGET_CATEGORIES}
    if age <= 34:
        weights["Headphones, Earbuds & Accessories"] *= 1.65
        weights["Wearable Technology"] *= 1.50
        weights["Computers & Accessories"] *= 1.20
    elif age >= 45:
        weights["Television & Video"] *= 1.50
        weights["Home Audio"] *= 1.40
        weights["Camera & Photo"] *= 1.12
    else:
        weights["Computers & Accessories"] *= 1.3
        weights["Camera & Photo"] *= 1.2

    # Personal variation prevents every person in a cohort from behaving alike.
    for category in weights:
        weights[category] *= rng.lognormvariate(0.0, 0.32)
    total = sum(weights.values())
    return {category: value / total for category, value in weights.items()}


def generate_users(count: int, seed: int, start: datetime, end: datetime) -> list[UserProfile]:
    rng = random.Random(seed + 101)
    bands = ((18, 24), (25, 34), (35, 44), (45, 54), (55, 64), (65, 74))
    band_weights = (15, 30, 25, 17, 9, 4)
    regions = ("SEOUL", "GYEONGGI", "BUSAN", "INCHEON", "DAEGU", "DAEJEON", "GWANGJU", "OTHER")
    region_weights = (35, 28, 10, 8, 6, 5, 4, 4)
    acquisition = ("organic", "paid_search", "social", "referral", "affiliate", "email", "direct")
    acquisition_weights = (25, 20, 16, 12, 8, 7, 12)

    profiles: list[UserProfile] = []
    for index in range(1, count + 1):
        low, high = weighted_choice(rng, bands, band_weights)
        age = rng.randint(low, high)
        gender = weighted_choice(rng, ("female", "male", "unknown"), (49, 49, 2))
        region = weighted_choice(rng, regions, region_weights)
        channel = weighted_choice(rng, acquisition, acquisition_weights)
        signup_days_before_end = rng.randint(2, 730)
        signup_at = end - timedelta(
            days=signup_days_before_end,
            hours=rng.randint(0, 23),
            minutes=rng.randint(0, 59),
        )

        tenure_days = (end - signup_at).days
        membership_weights = (72, 19, 7, 2) if tenure_days < 180 else (58, 25, 12, 5)
        membership = weighted_choice(rng, ("basic", "plus", "premium", "vip"), membership_weights)

        if age <= 34:
            device_weights = (77, 20, 3)
        elif age >= 55:
            device_weights = (48, 44, 8)
        else:
            device_weights = (64, 31, 5)
        primary_device = weighted_choice(rng, ("mobile", "desktop", "tablet"), device_weights)

        activity_tier = weighted_choice(rng, ("casual", "regular", "power"), (55, 35, 10))
        membership_price_shift = {"basic": 0.12, "plus": 0.02, "premium": -0.08, "vip": -0.15}[membership]
        price_sensitivity = clamp(rng.betavariate(2.2, 2.0) + membership_price_shift, 0.02, 0.98)
        purchase_propensity = clamp(rng.lognormvariate(-0.05, 0.28), 0.55, 1.7)

        public = {
            "user_id": f"USR-{index:06d}",
            "age": age,
            "gender": gender,
            "region": region,
            "signup_at": signup_at.isoformat(timespec="seconds"),
            "acquisition_channel": channel,
            "membership_tier": membership,
            "primary_device": primary_device,
        }
        profiles.append(
            UserProfile(
                public=public,
                activity_tier=activity_tier,
                price_sensitivity=price_sensitivity,
                purchase_propensity=purchase_propensity,
                category_weights=make_category_weights(rng, age),
            )
        )
    return profiles


def session_hour(rng: random.Random, device: str) -> int:
    hours = tuple(range(24))
    if device == "mobile":
        weights = tuple(4 if 18 <= hour <= 23 else 2 if 7 <= hour <= 17 else 0.5 for hour in hours)
    elif device == "desktop":
        weights = tuple(4 if 9 <= hour <= 18 else 1.2 if 19 <= hour <= 22 else 0.4 for hour in hours)
    else:
        weights = tuple(3.5 if 19 <= hour <= 23 else 1.5 if 8 <= hour <= 18 else 0.5 for hour in hours)
    return weighted_choice(rng, hours, weights)


def actual_device(rng: random.Random, primary: str) -> str:
    if rng.random() < 0.82:
        return primary
    alternatives = [item for item in ("mobile", "desktop", "tablet") if item != primary]
    return rng.choice(alternatives)


def actual_referrer(rng: random.Random, acquisition_channel: str) -> str:
    if rng.random() < 0.64:
        return acquisition_channel
    return weighted_choice(rng, ("direct", "organic", "email", "social"), (35, 35, 12, 18))


def product_popularity_weight(product: Product) -> float:
    review_signal = max(1.0, math.log1p(product.rating_count)) ** 1.18
    rating_signal = 0.7 + (product.average_rating / 5.0) * 0.6
    return review_signal * rating_signal


def choose_product(
    rng: random.Random,
    products: Sequence[Product],
    popularity_weights: Sequence[float],
) -> Product:
    # 70% popularity-driven and 30% uniform gives a realistic head while keeping
    # enough long-tail coverage for SQL exploration.
    if rng.random() < 0.70:
        return weighted_choice(rng, products, popularity_weights)
    return rng.choice(products)


def write_event(handle: Any, event: dict[str, Any]) -> int:
    encoded = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    handle.write(encoded + "\n")
    return len(encoded.encode("utf-8")) + 1


def generate_events(
    profiles: Sequence[UserProfile],
    products: Sequence[Product],
    output_path: Path,
    seed: int,
    start: datetime,
    end: datetime,
) -> dict[str, Any]:
    rng = random.Random(seed + 202)
    by_category: dict[str, list[Product]] = defaultdict(list)
    for product in products:
        by_category[product.category].append(product)
    popularity = {
        category: [product_popularity_weight(product) for product in items]
        for category, items in by_category.items()
    }

    event_counts: Counter[str] = Counter()
    product_exposure: set[str] = set()
    session_count = 0
    event_count = 0
    bytes_written = 0
    session_means = {"casual": 3.0, "regular": 8.0, "power": 20.0}
    # Effects are deliberately visible but moderate. Applying huge multipliers
    # would make SQL results look scripted instead of sampled from a population.
    membership_cart_multiplier = {"basic": 0.90, "plus": 1.00, "premium": 1.12, "vip": 1.25}
    membership_purchase_multiplier = {"basic": 0.95, "plus": 1.00, "premium": 1.10, "vip": 1.20}
    channel_cart_multiplier = {"referral": 1.12, "email": 1.06, "paid_search": 0.90}
    channel_purchase_multiplier = {"referral": 1.18, "email": 1.08, "paid_search": 0.90}

    with output_path.open("w", encoding="utf-8") as handle:
        for profile in profiles:
            user = profile.public
            signup_at = datetime.fromisoformat(user["signup_at"])
            eligible_start = max(start, signup_at)
            if eligible_start >= end:
                continue

            sessions_for_user = poisson(rng, session_means[profile.activity_tier])
            for _ in range(sessions_for_user):
                session_count += 1
                session_id = f"SES-{session_count:08d}"
                device = actual_device(rng, user["primary_device"])
                referrer = actual_referrer(rng, user["acquisition_channel"])
                span_seconds = max(1, int((end - eligible_start).total_seconds()))
                day_offset = rng.randrange(max(1, math.ceil(span_seconds / 86_400)))
                session_day = eligible_start + timedelta(days=day_offset)
                session_day = min(session_day, end - timedelta(seconds=1))
                started_at = session_day.replace(
                    hour=session_hour(rng, device),
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
                impressions = 1 + min(poisson(rng, 1.8), 5)
                current_time = started_at
                for position in range(1, impressions + 1):
                    category = weighted_choice(rng, categories, category_weights)
                    product = choose_product(rng, by_category[category], popularity[category])
                    product_exposure.add(product.product_id)
                    current_time += timedelta(seconds=rng.randint(4, 40))

                    def emit(event_type: str, page_url: str) -> None:
                        nonlocal event_count, bytes_written
                        event_count += 1
                        event_counts[event_type] += 1
                        event = {
                            "event_id": f"EVT-{event_count:09d}",
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
                        bytes_written += write_event(handle, event)

                    search_url = f"/search?category={quote_plus(category)}"
                    emit("product_impression", search_url)

                    affinity_ratio = profile.category_weights[category] * len(TARGET_CATEGORIES)
                    click_probability = 0.29 * (0.72 + 0.38 * min(affinity_ratio, 2.6))
                    click_probability *= 0.90 + 0.18 * (product.average_rating / 5.0)
                    click_probability *= {"mobile": 0.98, "desktop": 1.04, "tablet": 0.95}[device]
                    if rng.random() >= clamp(click_probability, 0.08, 0.72):
                        continue

                    current_time += timedelta(seconds=rng.randint(1, 18))
                    emit("product_click", f"/dp/{product.product_id}")

                    price_factor = 1.22 - profile.price_sensitivity * product.price_percentile * 0.72
                    cart_probability = 0.18 * membership_cart_multiplier[user["membership_tier"]]
                    cart_probability *= channel_cart_multiplier.get(user["acquisition_channel"], 1.0)
                    cart_probability *= price_factor
                    if rng.random() >= clamp(cart_probability, 0.025, 0.48):
                        continue

                    current_time += timedelta(seconds=rng.randint(8, 90))
                    emit("add_to_cart", f"/dp/{product.product_id}")

                    purchase_probability = 0.34 * membership_purchase_multiplier[user["membership_tier"]]
                    purchase_probability *= channel_purchase_multiplier.get(user["acquisition_channel"], 1.0)
                    purchase_probability *= price_factor * profile.purchase_propensity
                    if rng.random() >= clamp(purchase_probability, 0.04, 0.72):
                        continue

                    current_time += timedelta(seconds=rng.randint(15, 150))
                    emit("purchase_click", "/checkout")

    return {
        "event_count": event_count,
        "session_count": session_count,
        "event_type_counts": dict(event_counts),
        "products_exposed": len(product_exposure),
        "product_coverage_pct": round(len(product_exposure) / len(products) * 100, 2),
        "bytes_written": bytes_written,
    }


def write_csv(path: Path, columns: Iterable[str], rows: Iterable[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(columns))
        writer.writeheader()
        writer.writerows(rows)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    args = parse_args()
    if not args.source.is_file():
        raise SystemExit(f"source does not exist: {args.source}")
    if args.products <= 0 or args.users <= 0 or args.days <= 0:
        raise SystemExit("products, users, and days must be positive")

    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    start = datetime.fromisoformat(args.start_date).replace(tzinfo=KST)
    end = start + timedelta(days=args.days)

    products, selection_stats = select_products(args.source, args.products, args.seed)
    profiles = generate_users(args.users, args.seed, start, end)

    products_path = output_dir / "products.csv"
    users_path = output_dir / "users.csv"
    events_path = output_dir / "click_events.jsonl"
    write_csv(products_path, PRODUCT_COLUMNS, (item.as_csv_row() for item in products))
    write_csv(users_path, USER_COLUMNS, (item.public for item in profiles))
    event_stats = generate_events(profiles, products, events_path, args.seed, start, end)

    files = {}
    for path in (products_path, users_path, events_path):
        files[path.name] = {
            "bytes": path.stat().st_size,
            "mib": round(path.stat().st_size / 1024 / 1024, 3),
            "sha256": sha256_file(path),
        }

    manifest = {
        "generator_version": 1,
        "seed": args.seed,
        "source_file": args.source.name,
        "window": {"start": start.isoformat(), "end_exclusive": end.isoformat()},
        "counts": {
            "products": len(products),
            "users": len(profiles),
            **{key: value for key, value in event_stats.items() if key != "bytes_written"},
        },
        "product_selection": selection_stats,
        "public_user_columns": list(USER_COLUMNS),
        "hidden_generation_traits": [
            "activity_tier",
            "price_sensitivity",
            "purchase_propensity",
            "category_affinity",
        ],
        "planted_patterns": [
            "age 18-34 favors headphones, wearables, and computers",
            "age 45+ favors television/video and home audio",
            "referral users have higher cart and purchase-click propensity than paid-search users",
            "premium/vip users have higher funnel progression than basic users",
            "mobile sessions concentrate in local evening hours",
            "gender and region have no direct behavior multiplier and act as null controls",
        ],
        "files": files,
        "total_mib": round(sum(item["bytes"] for item in files.values()) / 1024 / 1024, 3),
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
