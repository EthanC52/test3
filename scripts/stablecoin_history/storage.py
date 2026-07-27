from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


class DataFileError(RuntimeError):
    """Raised when an existing history/state file cannot be safely used."""


@dataclass(frozen=True)
class HistorySpec:
    value_key: str
    precision: int


def load_json(path: str | Path, default: Any) -> Any:
    file_path = Path(path)
    if not file_path.exists():
        return default
    try:
        with file_path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise DataFileError(f"Impossible de lire {file_path}: {exc}") from exc


def load_history(path: str | Path, spec: HistorySpec) -> list[dict[str, Any]]:
    data = load_json(path, [])
    if not isinstance(data, list):
        raise DataFileError(f"{path} doit contenir une liste JSON")

    validated: list[dict[str, Any]] = []
    for index, item in enumerate(data):
        if not isinstance(item, dict):
            raise DataFileError(f"{path}[{index}] doit être un objet")
        date = item.get("date")
        value = item.get(spec.value_key)
        if not isinstance(date, str) or len(date) != 10:
            raise DataFileError(f"{path}[{index}].date est invalide")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise DataFileError(f"{path}[{index}].{spec.value_key} est invalide")
        validated.append(dict(item))
    return validated


def compact_number(value: float, precision: int) -> int | float:
    rounded = round(value, precision)
    if float(rounded).is_integer():
        return int(rounded)
    return rounded


def upsert_daily_points(
    existing: list[dict[str, Any]],
    points: Iterable[dict[str, Any]],
    spec: HistorySpec,
    *,
    preserve_marketcap_shape: bool = False,
) -> list[dict[str, Any]]:
    """Update only requested dates and preserve every other historical object.

    The original repository stores one object per UTC day. Runs during the same
    day therefore replace that day's value rather than adding duplicate records.
    Existing extra keys and duplicate legacy rows are retained; no old point is
    collapsed or deleted as a side effect of the refactor.
    """
    updates: dict[str, int | float] = {}
    for point in points:
        date_value = point.get("date")
        if not isinstance(date_value, str) or len(date_value) != 10:
            raise DataFileError(f"Date de snapshot invalide: {date_value!r}")
        raw_value = point.get(spec.value_key)
        if not isinstance(raw_value, (int, float)) or isinstance(raw_value, bool):
            raise DataFileError(
                f"Valeur {spec.value_key} invalide pour {date_value}: {raw_value!r}"
            )
        updates[date_value] = compact_number(float(raw_value), spec.precision)

    marketcap_shape = preserve_marketcap_shape and any(
        "marketcap" in item for item in existing
    )
    result: list[dict[str, Any]] = []
    touched_dates: set[str] = set()

    for original in existing:
        date_value = original["date"]
        if date_value not in updates:
            result.append(dict(original))
            continue

        merged = dict(original)
        value = updates[date_value]
        merged[spec.value_key] = value
        # EURCV's legacy files are {date, marketcap, supply}. With no FX source,
        # the nominal market cap in the token's peg currency equals its supply.
        if marketcap_shape and spec.value_key == "supply":
            merged["marketcap"] = value
        result.append(merged)
        touched_dates.add(date_value)

    for date_value in sorted(set(updates) - touched_dates):
        value = updates[date_value]
        if marketcap_shape and spec.value_key == "supply":
            # Match the legacy EURCV key order: date, marketcap, supply.
            item: dict[str, Any] = {
                "date": date_value,
                "marketcap": value,
                "supply": value,
            }
        else:
            item = {"date": date_value, spec.value_key: value}
        result.append(item)

    # Stable sort inserts missing backfilled ETH dates chronologically while
    # preserving the relative order (and count) of all legacy rows.
    return sorted(result, key=lambda item: item["date"])


def atomic_write_json(path: str | Path, data: Any) -> None:
    file_path = Path(path)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{file_path.name}.", suffix=".tmp", dir=file_path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, file_path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise
