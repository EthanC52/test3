from __future__ import annotations

import math
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from .http import RetryingSession, SourceError
from .storage import HistorySpec, atomic_write_json, load_history, upsert_daily_points

SOLSCAN_META_URL = "https://pro-api.solscan.io/v2.0/token/meta"


@dataclass(frozen=True)
class SolanaToken:
    name: str
    mint: str
    holders_file: str
    supply_file: str
    supply_precision: int
    legacy_marketcap_shape: bool = False


class SolscanClient:
    def __init__(self, api_key: str) -> None:
        if not api_key:
            raise SourceError("SOLSCAN_API_KEY absent")
        self.api_key = api_key
        self.http = RetryingSession(timeout=30, max_attempts=6, min_interval=0.25)

    def token_meta(self, mint: str) -> dict[str, Any]:
        payload = self.http.get_json(
            SOLSCAN_META_URL,
            params={"address": mint},
            headers={"token": self.api_key},
        )
        if payload.get("success") is not True:
            raise SourceError(f"Solscan a refusé la requête: {payload.get('errors') or payload}")
        data = payload.get("data")
        if not isinstance(data, dict):
            raise SourceError("Solscan token/meta sans objet data")
        if str(data.get("address", mint)) != mint:
            raise SourceError("Solscan a renvoyé un autre mint")
        return data


def last_supply(history: list[dict[str, Any]]) -> Decimal | None:
    if not history:
        return None
    try:
        return Decimal(str(history[-1]["supply"]))
    except (InvalidOperation, KeyError):
        return None


def normalize_solscan_supply(raw_value: Any, decimals: int, previous: Decimal | None) -> Decimal:
    try:
        raw = Decimal(str(raw_value))
    except InvalidOperation as exc:
        raise SourceError(f"Supply Solscan invalide: {raw_value}") from exc
    if not raw.is_finite() or raw < 0:
        raise SourceError(f"Supply Solscan invalide: {raw_value}")

    scaled = raw / (Decimal(10) ** decimals)
    if previous is None or previous <= 0:
        # Solscan serializes supply as a string to preserve precision.  Most API
        # responses expose raw mint units; choose scaled unless raw already has a
        # fractional component, which is a strong signal that it is normalized.
        return raw if raw != raw.to_integral_value() else scaled

    def distance(candidate: Decimal) -> float:
        if candidate <= 0:
            return math.inf
        return abs(math.log10(float(candidate / previous)))

    # Handles both Solscan representations safely and prevents a 10^decimals jump.
    return min((raw, scaled), key=distance)


def run_solscan(token: SolanaToken, *, now: datetime | None = None) -> dict[str, bool]:
    now = now or datetime.now(timezone.utc)
    day = now.date().isoformat()
    status = {"holders": False, "supply": False}

    try:
        client = SolscanClient(os.environ.get("SOLSCAN_API_KEY", ""))
        meta = client.token_meta(token.mint)
    except Exception as exc:
        print(f"[{token.name}] Solscan indisponible; historiques inchangés: {exc}")
        return status

    try:
        holders = int(meta["holder"])
        if holders < 0:
            raise ValueError("holder négatif")
        existing_holders = load_history(token.holders_file, HistorySpec("holders", 0))
        merged_holders = upsert_daily_points(
            existing_holders,
            [{"date": day, "holders": holders}],
            HistorySpec("holders", 0),
        )
        atomic_write_json(token.holders_file, merged_holders)
        status["holders"] = True
        print(f"[{token.name}] holders du {day}: {holders}")
    except Exception as exc:
        print(f"[{token.name}] holders conservés sans modification: {exc}")

    try:
        decimals = int(meta["decimals"])
        if decimals < 0 or decimals > 18:
            raise ValueError(f"decimals invalides: {decimals}")
        existing_supply = load_history(
            token.supply_file, HistorySpec("supply", token.supply_precision)
        )
        supply = normalize_solscan_supply(meta["supply"], decimals, last_supply(existing_supply))
        merged_supply = upsert_daily_points(
            existing_supply,
            [{"date": day, "supply": float(supply)}],
            HistorySpec("supply", token.supply_precision),
            preserve_marketcap_shape=token.legacy_marketcap_shape,
        )
        atomic_write_json(token.supply_file, merged_supply)
        status["supply"] = True
        print(f"[{token.name}] supply du {day}: {supply}")
    except Exception as exc:
        print(f"[{token.name}] supply conservée sans modification: {exc}")

    return status
