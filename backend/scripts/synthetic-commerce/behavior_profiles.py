"""Shared behavior profiles for the deterministic synthetic commerce generator."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any


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
    weekend_days = {day.date() for day in weekend_dates}
    payday = next((item for item in dates if item.day == 25 and item.date() not in weekend_days), None)
    if payday is None:
        candidates = [item for item in dates if item.date() not in weekend_days]
        payday = candidates[len(candidates) // 2]

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
    return {
        date: profile["multipliers"]
        for profile in profiles.values()
        for date in profile["dates"]
    }
