#!/usr/bin/env python3
"""Generate deterministic, prefix-oriented synthetic commerce datasets.

The Amazon metadata source is scanned as JSONL and is never loaded in full.
Selected products are normalized, synthetic users are generated from a seed,
and every click event references one of those products and users.
"""

from __future__ import annotations

import argparse
import bisect
import hashlib
import heapq
import json
import math
import random
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, BinaryIO, Iterable, Iterator, Sequence
from urllib.parse import quote_plus


KST = timezone(timedelta(hours=9))
MEBIBYTE = 1024 * 1024
DEFAULT_USERS = 3_000
SIZING_SAMPLE_USERS = 300
GENERATOR_VERSION = 3

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

CATEGORY_PURCHASE_PROFILE = {
    "Computers & Accessories": {"group": "medium", "multiplier": 1.00},
    "Camera & Photo": {"group": "medium", "multiplier": 1.00},
    "Television & Video": {"group": "low", "multiplier": 0.70},
    "Headphones, Earbuds & Accessories": {"group": "high", "multiplier": 1.30},
    "Home Audio": {"group": "medium", "multiplier": 1.00},
    "Car & Vehicle Electronics": {"group": "low", "multiplier": 0.70},
    "Portable Audio & Video": {"group": "low", "multiplier": 0.70},
    "Wearable Technology": {"group": "high", "multiplier": 1.30},
}

DEFAULT_DATE_MULTIPLIERS = {
    "traffic": 1.0,
    "impression_to_click": 1.0,
    "click_to_cart": 1.0,
    "cart_to_purchase_click": 1.0,
}

DATE_PROFILE_MULTIPLIERS = {
    "weekend_campaign": {
        "traffic": 1.60,
        "impression_to_click": 0.72,
        "click_to_cart": 0.86,
        "cart_to_purchase_click": 0.95,
    },
    "payday_promotion": {
        "traffic": 1.00,
        "impression_to_click": 1.00,
        "click_to_cart": 1.35,
        "cart_to_purchase_click": 1.15,
    },
}

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

    def as_json_row(self) -> dict[str, Any]:
        return {
            "product_id": self.product_id,
            "category": self.category,
            "leaf_category": self.leaf_category,
            "title": self.title,
            "store": self.store,
            "price": round(self.price, 2),
            "average_rating": round(self.average_rating, 1),
            "rating_count": self.rating_count,
        }

    # Kept for callers that used the original CSV-oriented helper.
    def as_csv_row(self) -> dict[str, Any]:
        row = self.as_json_row()
        row["price"] = f"{self.price:.2f}"
        row["average_rating"] = f"{self.average_rating:.1f}"
        return row


@dataclass
class UserProfile:
    public: dict[str, Any]
    activity_tier: str
    price_sensitivity: float
    purchase_propensity: float
    category_weights: dict[str, float]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--products", type=int, default=10_000)
    parser.add_argument(
        "--users",
        type=int,
        help=(
            "exact user count for fixed-count generation; defaults to 3000 when "
            "--target-total-size-mb is omitted"
        ),
    )
    parser.add_argument(
        "--target-total-size-mb",
        type=float,
        help="approximate combined size of meta, users, and click_events (MiB)",
    )
    parser.add_argument(
        "--max-file-size-mb",
        type=float,
        default=64.0,
        help="maximum JSONL part size (MiB); default: 64",
    )
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


def build_date_profiles(start: datetime, end: datetime) -> dict[str, dict[str, Any]]:
    """Resolve named date profiles inside the requested generation window."""
    dates: list[datetime] = []
    current = start
    while current < end:
        dates.append(current)
        current += timedelta(days=1)
    if len(dates) < 3:
        return {}

    weekend_dates = [item for item in dates if item.weekday() >= 5][:2]
    if not weekend_dates:
        weekend_dates = [dates[min(1, len(dates) - 1)]]

    payday = next(
        (item for item in dates if item.day == 25 and item.date() not in {day.date() for day in weekend_dates}),
        None,
    )
    if payday is None:
        payday_candidates = [
            item for item in dates if item.date() not in {day.date() for day in weekend_dates}
        ]
        payday = payday_candidates[len(payday_candidates) // 2]

    return {
        "weekend_campaign": {
            "dates": [item.date().isoformat() for item in weekend_dates],
            "multipliers": dict(DATE_PROFILE_MULTIPLIERS["weekend_campaign"]),
        },
        "payday_promotion": {
            "dates": [payday.date().isoformat()],
            "multipliers": dict(DATE_PROFILE_MULTIPLIERS["payday_promotion"]),
        },
    }


def date_multiplier_lookup(
    profiles: dict[str, dict[str, Any]],
) -> dict[str, dict[str, float]]:
    lookup: dict[str, dict[str, float]] = {}
    for profile in profiles.values():
        for date in profile["dates"]:
            lookup[date] = profile["multipliers"]
    return lookup


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


def encode_jsonl(row: dict[str, Any]) -> bytes:
    return (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


class JsonlByteCounter:
    """Record sink used by deterministic size planning without writing files."""

    def __init__(self) -> None:
        self.rows = 0
        self.bytes = 0

    def write(self, row: dict[str, Any]) -> int:
        size = len(encode_jsonl(row))
        self.rows += 1
        self.bytes += size
        return size

    def close(self) -> None:
        return None


class SingleJsonlWriter:
    """Compatibility sink for callers that still pass one output file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.handle: BinaryIO = path.open("wb")
        self.rows = 0
        self.bytes = 0

    def write(self, row: dict[str, Any]) -> int:
        encoded = encode_jsonl(row)
        self.handle.write(encoded)
        self.rows += 1
        self.bytes += len(encoded)
        return len(encoded)

    def close(self) -> None:
        if not self.handle.closed:
            self.handle.close()


class JsonlPartWriter:
    """Write newline-delimited JSON records into deterministic capped parts."""

    def __init__(self, run_dir: Path, dataset: str, max_file_bytes: int) -> None:
        self.run_dir = run_dir
        self.dataset = dataset
        self.dataset_dir = run_dir / dataset
        self.dataset_dir.mkdir(parents=True, exist_ok=False)
        self.max_file_bytes = max_file_bytes
        self.rows = 0
        self.bytes = 0
        self.files: list[dict[str, Any]] = []
        self._handle: BinaryIO | None = None
        self._path: Path | None = None
        self._part_rows = 0
        self._part_bytes = 0
        self._digest: Any = None

    def _open_part(self) -> None:
        self._path = self.dataset_dir / f"part-{len(self.files):05d}.jsonl"
        self._handle = self._path.open("wb")
        self._part_rows = 0
        self._part_bytes = 0
        self._digest = hashlib.sha256()

    def _close_part(self) -> None:
        if self._handle is None or self._path is None:
            return
        self._handle.close()
        self.files.append(
            {
                "path": self._path.relative_to(self.run_dir).as_posix(),
                "rows": self._part_rows,
                "bytes": self._part_bytes,
                "sha256": self._digest.hexdigest(),
            }
        )
        self._handle = None
        self._path = None
        self._digest = None

    def write(self, row: dict[str, Any]) -> int:
        encoded = encode_jsonl(row)
        if self._handle is not None and self._part_bytes + len(encoded) > self.max_file_bytes:
            self._close_part()
        if self._handle is None:
            self._open_part()
        assert self._handle is not None and self._digest is not None
        self._handle.write(encoded)
        self._digest.update(encoded)
        self._part_rows += 1
        self._part_bytes += len(encoded)
        self.rows += 1
        self.bytes += len(encoded)
        return len(encoded)

    def close(self) -> None:
        self._close_part()

    def manifest_entry(self) -> dict[str, Any]:
        if self._handle is not None:
            raise RuntimeError(f"{self.dataset} writer must be closed before building the manifest")
        return {
            "format": "jsonl",
            "prefix": f"{self.dataset}/",
            "rows": self.rows,
            "bytes": self.bytes,
            "mib": round(self.bytes / MEBIBYTE, 6),
            "file_count": len(self.files),
            "files": self.files,
        }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(MEBIBYTE), b""):
            digest.update(block)
    return digest.hexdigest()


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

    # Only the bounded per-category heaps are retained; the source can be many GiB.
    with source.open("r", encoding="utf-8") as handle:
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

    for category in weights:
        weights[category] *= rng.lognormvariate(0.0, 0.32)
    total = sum(weights.values())
    return {category: value / total for category, value in weights.items()}


def iter_user_profiles(
    count: int,
    seed: int,
    start: datetime,
    end: datetime,
) -> Iterator[UserProfile]:
    rng = random.Random(seed + 101)
    bands = ((18, 24), (25, 34), (35, 44), (45, 54), (55, 64), (65, 74))
    band_weights = (15, 30, 25, 17, 9, 4)
    regions = ("SEOUL", "GYEONGGI", "BUSAN", "INCHEON", "DAEGU", "DAEJEON", "GWANGJU", "OTHER")
    region_weights = (35, 28, 10, 8, 6, 5, 4, 4)
    acquisition = ("organic", "paid_search", "social", "referral", "affiliate", "email", "direct")
    acquisition_weights = (25, 20, 16, 12, 8, 7, 12)

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
        yield UserProfile(
            public=public,
            activity_tier=activity_tier,
            price_sensitivity=price_sensitivity,
            purchase_propensity=purchase_propensity,
            category_weights=make_category_weights(rng, age),
        )


def generate_users(count: int, seed: int, start: datetime, end: datetime) -> list[UserProfile]:
    return list(iter_user_profiles(count, seed, start, end))


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
    cumulative_popularity: Sequence[float],
) -> Product:
    # Cumulative weights avoid rebuilding a large weighted-choice table for every event.
    if rng.random() < 0.70:
        position = rng.random() * cumulative_popularity[-1]
        return products[bisect.bisect_left(cumulative_popularity, position)]
    return rng.choice(products)


def generate_events(
    profiles: Iterable[UserProfile],
    products: Sequence[Product],
    output: Path | JsonlByteCounter | JsonlPartWriter | SingleJsonlWriter,
    seed: int,
    start: datetime,
    end: datetime,
) -> dict[str, Any]:
    owns_writer = isinstance(output, Path)
    writer: JsonlByteCounter | JsonlPartWriter | SingleJsonlWriter
    writer = SingleJsonlWriter(output) if owns_writer else output
    rng = random.Random(seed + 202)
    by_category: dict[str, list[Product]] = defaultdict(list)
    for product in products:
        by_category[product.category].append(product)
    cumulative_popularity: dict[str, list[float]] = {}
    for category, items in by_category.items():
        running = 0.0
        cumulative = []
        for item in items:
            running += product_popularity_weight(item)
            cumulative.append(running)
        cumulative_popularity[category] = cumulative

    event_counts: Counter[str] = Counter()
    product_exposure: set[str] = set()
    session_count = 0
    event_count = 0
    bytes_written = 0
    session_means = {"casual": 3.0, "regular": 8.0, "power": 20.0}
    membership_cart_multiplier = {"basic": 0.90, "plus": 1.00, "premium": 1.12, "vip": 1.25}
    membership_purchase_multiplier = {"basic": 0.95, "plus": 1.00, "premium": 1.10, "vip": 1.20}
    channel_cart_multiplier = {"referral": 1.12, "email": 1.06, "paid_search": 0.90}
    channel_purchase_multiplier = {"referral": 1.18, "email": 1.08, "paid_search": 0.90}
    last_valid_event_time = end - timedelta(microseconds=1)
    date_profiles = build_date_profiles(start, end)
    multipliers_by_date = date_multiplier_lookup(date_profiles)

    try:
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
                eligible_dates: list[datetime] = []
                candidate_day = eligible_start.replace(hour=0, minute=0, second=0, microsecond=0)
                while candidate_day < end:
                    if candidate_day + timedelta(days=1) > eligible_start:
                        eligible_dates.append(candidate_day)
                    candidate_day += timedelta(days=1)
                session_day = weighted_choice(
                    rng,
                    eligible_dates,
                    [
                        multipliers_by_date.get(
                            item.date().isoformat(), DEFAULT_DATE_MULTIPLIERS
                        )["traffic"]
                        for item in eligible_dates
                    ],
                )
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
                date_multipliers = multipliers_by_date.get(
                    started_at.date().isoformat(), DEFAULT_DATE_MULTIPLIERS
                )

                categories = tuple(profile.category_weights)
                category_weights = tuple(profile.category_weights[item] for item in categories)
                impressions = 1 + min(poisson(rng, 1.8), 5)
                current_time = started_at
                for position in range(1, impressions + 1):
                    category = weighted_choice(rng, categories, category_weights)
                    product = choose_product(
                        rng,
                        by_category[category],
                        cumulative_popularity[category],
                    )
                    product_exposure.add(product.product_id)
                    current_time = min(current_time + timedelta(seconds=rng.randint(4, 40)), last_valid_event_time)

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
                        bytes_written += writer.write(event)

                    search_url = f"/search?category={quote_plus(category)}"
                    emit("product_impression", search_url)

                    affinity_ratio = profile.category_weights[category] * len(TARGET_CATEGORIES)
                    click_probability = 0.29 * (0.72 + 0.38 * min(affinity_ratio, 2.6))
                    click_probability *= 0.90 + 0.18 * (product.average_rating / 5.0)
                    click_probability *= {"mobile": 0.98, "desktop": 1.04, "tablet": 0.95}[device]
                    click_probability *= date_multipliers["impression_to_click"]
                    if rng.random() >= clamp(click_probability, 0.08, 0.72):
                        continue

                    current_time = min(current_time + timedelta(seconds=rng.randint(1, 18)), last_valid_event_time)
                    emit("product_click", f"/dp/{product.product_id}")

                    price_factor = 1.22 - profile.price_sensitivity * product.price_percentile * 0.72
                    cart_probability = 0.18 * membership_cart_multiplier[user["membership_tier"]]
                    cart_probability *= channel_cart_multiplier.get(user["acquisition_channel"], 1.0)
                    cart_probability *= price_factor
                    cart_probability *= date_multipliers["click_to_cart"]
                    if rng.random() >= clamp(cart_probability, 0.025, 0.48):
                        continue

                    current_time = min(current_time + timedelta(seconds=rng.randint(8, 90)), last_valid_event_time)
                    emit("add_to_cart", f"/dp/{product.product_id}")

                    purchase_probability = 0.34 * membership_purchase_multiplier[user["membership_tier"]]
                    purchase_probability *= channel_purchase_multiplier.get(user["acquisition_channel"], 1.0)
                    purchase_probability *= price_factor * profile.purchase_propensity
                    purchase_probability *= CATEGORY_PURCHASE_PROFILE[category]["multiplier"]
                    purchase_probability *= date_multipliers["cart_to_purchase_click"]
                    if rng.random() >= clamp(purchase_probability, 0.04, 0.72):
                        continue

                    current_time = min(current_time + timedelta(seconds=rng.randint(15, 150)), last_valid_event_time)
                    emit("purchase_click", "/checkout")
    finally:
        if owns_writer:
            writer.close()

    return {
        "event_count": event_count,
        "session_count": session_count,
        "event_type_counts": dict(event_counts),
        "products_exposed": len(product_exposure),
        "product_coverage_pct": round(len(product_exposure) / len(products) * 100, 2),
        "bytes_written": bytes_written,
    }


def measure_variable_bytes(
    user_count: int,
    products: Sequence[Product],
    seed: int,
    start: datetime,
    end: datetime,
) -> int:
    users = JsonlByteCounter()
    for profile in iter_user_profiles(user_count, seed, start, end):
        users.write(profile.public)
    events = JsonlByteCounter()
    generate_events(iter_user_profiles(user_count, seed, start, end), products, events, seed, start, end)
    return users.bytes + events.bytes


def resolve_user_count_for_target(
    target_bytes: int,
    meta_bytes: int,
    products: Sequence[Product],
    seed: int,
    start: datetime,
    end: datetime,
) -> int:
    remaining = target_bytes - meta_bytes
    if remaining <= 0:
        return 1

    sample_bytes = measure_variable_bytes(SIZING_SAMPLE_USERS, products, seed, start, end)
    if sample_bytes <= 0:
        raise RuntimeError("sizing sample produced no user or event bytes")
    estimate = max(1, round(remaining * SIZING_SAMPLE_USERS / sample_bytes))

    measured = measure_variable_bytes(estimate, products, seed, start, end)
    if measured <= 0:
        return estimate
    corrected = max(1, round(estimate * remaining / measured))
    return corrected


def validate_run_id(run_id: str) -> None:
    if not run_id or Path(run_id).name != run_id or run_id in {".", ".."}:
        raise ValueError("run-id must be one non-empty path segment")


def generate_dataset(
    *,
    source: Path,
    output_dir: Path,
    run_id: str,
    product_count: int = 10_000,
    user_count: int | None = None,
    target_total_size_mb: float | None = None,
    max_file_size_mb: float = 64.0,
    seed: int = 20260711,
    start_date: str = "2026-06-01",
    days: int = 30,
) -> dict[str, Any]:
    validate_run_id(run_id)
    if not source.is_file():
        raise ValueError(f"source does not exist: {source}")
    if product_count <= 0:
        raise ValueError("products must be positive")
    if days < 3:
        raise ValueError("days must be at least 3 so both date profiles can be planted")
    if user_count is not None and user_count <= 0:
        raise ValueError("users must be positive")
    if target_total_size_mb is not None and target_total_size_mb <= 0:
        raise ValueError("target-total-size-mb must be positive")
    if max_file_size_mb <= 0:
        raise ValueError("max-file-size-mb must be positive")
    if user_count is not None and target_total_size_mb is not None:
        raise ValueError("--users and --target-total-size-mb cannot be combined")

    output_root = output_dir.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    run_dir = output_root / run_id
    if run_dir.exists():
        raise FileExistsError(f"run directory already exists: {run_dir}")
    run_dir.mkdir()

    start = datetime.fromisoformat(start_date)
    if start.tzinfo is None:
        start = start.replace(tzinfo=KST)
    end = start + timedelta(days=days)
    max_file_bytes = max(1, round(max_file_size_mb * MEBIBYTE))

    products, selection_stats = select_products(source, product_count, seed)
    meta_writer = JsonlPartWriter(run_dir, "meta", max_file_bytes)
    for product in products:
        meta_writer.write(product.as_json_row())
    meta_writer.close()
    meta_entry = meta_writer.manifest_entry()

    requested_users = user_count
    if target_total_size_mb is not None:
        resolved_users = resolve_user_count_for_target(
            round(target_total_size_mb * MEBIBYTE),
            meta_entry["bytes"],
            products,
            seed,
            start,
            end,
        )
        sizing_mode = "target_total_size"
    else:
        resolved_users = user_count if user_count is not None else DEFAULT_USERS
        sizing_mode = "fixed_users"

    users_writer = JsonlPartWriter(run_dir, "users", max_file_bytes)
    for profile in iter_user_profiles(resolved_users, seed, start, end):
        users_writer.write(profile.public)
    users_writer.close()

    events_writer = JsonlPartWriter(run_dir, "click_events", max_file_bytes)
    event_stats = generate_events(
        iter_user_profiles(resolved_users, seed, start, end),
        products,
        events_writer,
        seed,
        start,
        end,
    )
    events_writer.close()

    datasets = {
        "meta": meta_entry,
        "users": users_writer.manifest_entry(),
        "click_events": events_writer.manifest_entry(),
    }
    total_bytes = sum(entry["bytes"] for entry in datasets.values())
    target_bytes = round(target_total_size_mb * MEBIBYTE) if target_total_size_mb is not None else None
    size_error_pct = (
        round(100.0 * (total_bytes - target_bytes) / target_bytes, 3)
        if target_bytes is not None
        else None
    )
    all_files = [file for dataset in datasets.values() for file in dataset["files"]]

    manifest = {
        "generator_version": GENERATOR_VERSION,
        "run_id": run_id,
        "seed": seed,
        "source_file": source.name,
        "window": {"start": start.isoformat(), "end_exclusive": end.isoformat()},
        "sizing": {
            "mode": sizing_mode,
            "requested_products": product_count,
            "requested_users": requested_users,
            "target_total_size_mb": target_total_size_mb,
            "max_file_size_mb": max_file_size_mb,
            "resolved_products": len(products),
            "resolved_users": resolved_users,
            "actual_total_bytes": total_bytes,
            "actual_total_mib": round(total_bytes / MEBIBYTE, 6),
            "target_size_error_pct": size_error_pct,
        },
        "resolved_counts": {
            "products": len(products),
            "users": resolved_users,
            "click_events": event_stats["event_count"],
            "sessions": event_stats["session_count"],
        },
        # Preserve common v1 consumers while the richer v2 fields are adopted.
        "counts": {
            "products": len(products),
            "users": resolved_users,
            **{key: value for key, value in event_stats.items() if key != "bytes_written"},
        },
        "product_selection": selection_stats,
        "behavior_profile": {
            "version": 1,
            "category_purchase_intent": {
                "applied_stage": "cart_to_purchase_click",
                "categories": CATEGORY_PURCHASE_PROFILE,
            },
            "date_profiles": build_date_profiles(start, end),
            "thresholds": {
                "category_adjacent_group_gap_pp": 1.0,
                "category_max_min_gap_pp": 3.0,
                "category_max_min_ratio": 1.5,
                "minimum_clicks_per_category": 1_000,
                "minimum_purchase_clicks_per_category": 50,
                "weekend_campaign_traffic_ratio": 1.20,
                "weekend_campaign_ctr_drop_pp": 2.0,
                "payday_traffic_tolerance_pct": 10.0,
                "payday_click_to_cart_lift_pp": 3.0,
            },
        },
        "datasets": datasets,
        "files": all_files,
        "total_bytes": total_bytes,
        "total_mib": round(total_bytes / MEBIBYTE, 6),
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
            "category purchase-click propensity follows high, medium, and low groups",
            "the first weekend campaign increases traffic while lowering CTR",
            "the payday promotion keeps traffic near normal while increasing click-to-cart progression",
        ],
    }
    manifest_path = run_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> None:
    args = parse_args()
    try:
        manifest = generate_dataset(
            source=args.source,
            output_dir=args.output_dir,
            run_id=args.run_id,
            product_count=args.products,
            user_count=args.users,
            target_total_size_mb=args.target_total_size_mb,
            max_file_size_mb=args.max_file_size_mb,
            seed=args.seed,
            start_date=args.start_date,
            days=args.days,
        )
    except (ValueError, RuntimeError, FileExistsError) as error:
        raise SystemExit(str(error)) from error
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
