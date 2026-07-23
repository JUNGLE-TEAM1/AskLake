"""Event generation helpers for the synthetic commerce dataset."""

from __future__ import annotations

import bisect
import hashlib
import json
import math
import random
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable, Sequence
from urllib.parse import quote_plus

from behavior_profiles import (
    CATEGORY_PURCHASE_PROFILE,
    DEFAULT_DATE_MULTIPLIERS,
    TARGET_CATEGORIES,
    build_date_profiles,
    date_multiplier_lookup,
)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def poisson(rng: random.Random, mean: float) -> int:
    limit = math.exp(-mean)
    product = 1.0
    count = 0
    while product > limit:
        count += 1
        product *= rng.random()
    return count - 1


def weighted_choice(rng: random.Random, values: Sequence[Any], weights: Sequence[float]) -> Any:
    return rng.choices(values, weights=weights, k=1)[0]


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


def product_popularity_weight(product: Any) -> float:
    review_signal = max(1.0, math.log1p(product.rating_count)) ** 1.18
    rating_signal = 0.7 + (product.average_rating / 5.0) * 0.6
    return review_signal * rating_signal


def choose_product(
    rng: random.Random,
    products: Sequence[Any],
    cumulative_popularity: Sequence[float],
) -> Any:
    if rng.random() < 0.70:
        position = rng.random() * cumulative_popularity[-1]
        return products[bisect.bisect_left(cumulative_popularity, position)]
    return rng.choice(products)


def encode_jsonl(row: dict[str, Any]) -> bytes:
    return (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


class _SingleJsonlWriter:
    def __init__(self, path: Path) -> None:
        self.handle = path.open("wb")

    def write(self, row: dict[str, Any]) -> int:
        encoded = encode_jsonl(row)
        self.handle.write(encoded)
        return len(encoded)

    def close(self) -> None:
        self.handle.close()


@dataclass
class _EventState:
    rng: random.Random
    writer: Any
    by_category: dict[str, list[Any]]
    cumulative_popularity: dict[str, list[float]]
    multipliers_by_date: dict[str, dict[str, float]]
    last_valid_event_time: datetime
    event_counts: Counter[str] = field(default_factory=Counter)
    product_exposure: set[str] = field(default_factory=set)
    session_count: int = 0
    event_count: int = 0
    bytes_written: int = 0


def _build_cumulative_popularity(products: Sequence[Any]) -> tuple[dict[str, list[Any]], dict[str, list[float]]]:
    by_category: dict[str, list[Any]] = defaultdict(list)
    for product in products:
        by_category[product.category].append(product)
    cumulative_popularity: dict[str, list[float]] = {}
    for category, items in by_category.items():
        running = 0.0
        cumulative: list[float] = []
        for item in items:
            running += product_popularity_weight(item)
            cumulative.append(running)
        cumulative_popularity[category] = cumulative
    return by_category, cumulative_popularity


def _emit_event(
    state: _EventState,
    user: dict[str, Any],
    session_id: str,
    current_time: datetime,
    product: Any,
    device: str,
    referrer: str,
    position: int,
    event_type: str,
    page_url: str,
) -> None:
    state.event_count += 1
    state.event_counts[event_type] += 1
    state.bytes_written += state.writer.write(
        {
            "event_id": f"EVT-{state.event_count:09d}",
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


def _eligible_dates(eligible_start: datetime, end: datetime) -> list[datetime]:
    dates: list[datetime] = []
    candidate_day = eligible_start.replace(hour=0, minute=0, second=0, microsecond=0)
    while candidate_day < end:
        if candidate_day + timedelta(days=1) > eligible_start:
            dates.append(candidate_day)
        candidate_day += timedelta(days=1)
    return dates


def _emit_session(
    state: _EventState,
    profile: Any,
    user: dict[str, Any],
    eligible_start: datetime,
    end: datetime,
) -> None:
    device = actual_device(state.rng, user["primary_device"])
    referrer = actual_referrer(state.rng, user["acquisition_channel"])
    dates = _eligible_dates(eligible_start, end)
    session_day = weighted_choice(
        state.rng,
        dates,
        [
            state.multipliers_by_date.get(item.date().isoformat(), DEFAULT_DATE_MULTIPLIERS)["traffic"]
            for item in dates
        ],
    )
    started_at = session_day.replace(
        hour=session_hour(state.rng, device),
        minute=state.rng.randint(0, 59),
        second=state.rng.randint(0, 59),
        microsecond=0,
    )
    if started_at < eligible_start:
        started_at = eligible_start.replace(microsecond=0)
    if started_at >= end:
        started_at = end - timedelta(seconds=1)
    date_multipliers = state.multipliers_by_date.get(
        started_at.date().isoformat(), DEFAULT_DATE_MULTIPLIERS
    )
    categories = tuple(profile.category_weights)
    category_weights = tuple(profile.category_weights[item] for item in categories)
    current_time = started_at
    session_id = f"SES-{state.session_count:08d}"
    for position in range(1, 1 + min(poisson(state.rng, 1.8), 5)):
        category = weighted_choice(state.rng, categories, category_weights)
        product = choose_product(
            state.rng,
            state.by_category[category],
            state.cumulative_popularity[category],
        )
        state.product_exposure.add(product.product_id)
        current_time = min(
            current_time + timedelta(seconds=state.rng.randint(4, 40)),
            state.last_valid_event_time,
        )
        _emit_event(
            state, user, session_id, current_time, product, device, referrer, position,
            "product_impression", f"/search?category={quote_plus(category)}",
        )
        affinity_ratio = profile.category_weights[category] * len(TARGET_CATEGORIES)
        click_probability = 0.29 * (0.72 + 0.38 * min(affinity_ratio, 2.6))
        click_probability *= 0.90 + 0.18 * (product.average_rating / 5.0)
        click_probability *= {"mobile": 0.98, "desktop": 1.04, "tablet": 0.95}[device]
        click_probability *= date_multipliers["impression_to_click"]
        if state.rng.random() >= clamp(click_probability, 0.08, 0.72):
            continue
        current_time = min(
            current_time + timedelta(seconds=state.rng.randint(1, 18)),
            state.last_valid_event_time,
        )
        _emit_event(state, user, session_id, current_time, product, device, referrer, position, "product_click", f"/dp/{product.product_id}")
        price_factor = 1.22 - profile.price_sensitivity * product.price_percentile * 0.72
        cart_probability = 0.18 * {"basic": 0.90, "plus": 1.00, "premium": 1.12, "vip": 1.25}[user["membership_tier"]]
        cart_probability *= {"referral": 1.12, "email": 1.06, "paid_search": 0.90}.get(user["acquisition_channel"], 1.0)
        cart_probability *= price_factor * date_multipliers["click_to_cart"]
        if state.rng.random() >= clamp(cart_probability, 0.025, 0.48):
            continue
        current_time = min(
            current_time + timedelta(seconds=state.rng.randint(8, 90)),
            state.last_valid_event_time,
        )
        _emit_event(state, user, session_id, current_time, product, device, referrer, position, "add_to_cart", f"/dp/{product.product_id}")
        purchase_probability = 0.34 * {"basic": 0.95, "plus": 1.00, "premium": 1.10, "vip": 1.20}[user["membership_tier"]]
        purchase_probability *= {"referral": 1.18, "email": 1.08, "paid_search": 0.90}.get(user["acquisition_channel"], 1.0)
        purchase_probability *= price_factor * profile.purchase_propensity
        purchase_probability *= CATEGORY_PURCHASE_PROFILE[category]["multiplier"]
        purchase_probability *= date_multipliers["cart_to_purchase_click"]
        if state.rng.random() >= clamp(purchase_probability, 0.04, 0.72):
            continue
        current_time = min(
            current_time + timedelta(seconds=state.rng.randint(15, 150)),
            state.last_valid_event_time,
        )
        _emit_event(state, user, session_id, current_time, product, device, referrer, position, "purchase_click", "/checkout")


def _generate_profile(state: _EventState, profile: Any, start: datetime, end: datetime) -> None:
    user = profile.public
    eligible_start = max(start, datetime.fromisoformat(user["signup_at"]))
    if eligible_start >= end:
        return
    session_means = {"casual": 3.0, "regular": 8.0, "power": 20.0}
    for _ in range(poisson(state.rng, session_means[profile.activity_tier])):
        state.session_count += 1
        _emit_session(state, profile, user, eligible_start, end)


def generate_events(
    profiles: Iterable[Any],
    products: Sequence[Any],
    output: Any,
    seed: int,
    start: datetime,
    end: datetime,
) -> dict[str, Any]:
    owns_writer = isinstance(output, Path)
    writer = _SingleJsonlWriter(output) if owns_writer else output
    by_category, cumulative_popularity = _build_cumulative_popularity(products)
    state = _EventState(
        rng=random.Random(seed + 202),
        writer=writer,
        by_category=by_category,
        cumulative_popularity=cumulative_popularity,
        multipliers_by_date=date_multiplier_lookup(build_date_profiles(start, end)),
        last_valid_event_time=end - timedelta(microseconds=1),
    )
    try:
        for profile in profiles:
            _generate_profile(state, profile, start, end)
    finally:
        if owns_writer:
            writer.close()
    return {
        "event_count": state.event_count,
        "session_count": state.session_count,
        "event_type_counts": dict(state.event_counts),
        "products_exposed": len(state.product_exposure),
        "product_coverage_pct": round(len(state.product_exposure) / len(products) * 100, 2),
        "bytes_written": state.bytes_written,
    }
