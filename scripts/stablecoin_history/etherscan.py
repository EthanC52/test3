from __future__ import annotations

import os
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time as dt_time, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from .http import RetryingSession, SourceError
from .storage import (
    DataFileError,
    HistorySpec,
    atomic_write_json,
    load_history,
    load_json,
    upsert_daily_points,
)

ETHERSCAN_URL = "https://api.etherscan.io/v2/api"
CHAIN_ID = 1
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
DECIMALS_SELECTOR = "0x313ce567"
TOTAL_SUPPLY_SELECTOR = "0x18160ddd"
PAGE_SIZE = 1000


@dataclass(frozen=True)
class EthereumToken:
    name: str
    address: str
    holders_file: str
    supply_file: str
    state_file: str
    supply_precision: int
    legacy_marketcap_shape: bool = False


class EtherscanClient:
    def __init__(self, api_key: str) -> None:
        if not api_key:
            raise SourceError("ETHERSCAN_API_KEY absent")
        self.api_key = api_key
        # Free tier is 3 calls/s; historical endpoints are safer below 2 calls/s.
        self.http = RetryingSession(timeout=35, max_attempts=6, min_interval=0.55)

    def call(self, params: dict[str, Any]) -> Any:
        query = dict(params)
        query["chainid"] = CHAIN_ID
        query["apikey"] = self.api_key
        payload = self.http.get_json(ETHERSCAN_URL, params=query)
        if "result" not in payload:
            raise SourceError(f"Réponse Etherscan incomplète: {payload}")
        result = payload.get("result")
        status = str(payload.get("status", ""))
        message = str(payload.get("message", ""))
        if status == "0" and isinstance(result, str):
            lowered = result.lower()
            if "no records" not in lowered and "no transactions" not in lowered:
                raise SourceError(f"Etherscan: {message or result}: {result}")
        return result

    def current_block(self) -> int:
        result = self.call({"module": "proxy", "action": "eth_blockNumber"})
        return parse_int(result)

    def block_by_timestamp(self, timestamp: int) -> int:
        result = self.call(
            {
                "module": "block",
                "action": "getblocknobytime",
                "timestamp": timestamp,
                "closest": "before",
            }
        )
        return parse_int(result)

    def eth_call(self, address: str, selector: str, block: int) -> int:
        result = self.call(
            {
                "module": "proxy",
                "action": "eth_call",
                "to": address,
                "data": selector,
                "tag": hex(block),
            }
        )
        if not isinstance(result, str) or not result.startswith("0x"):
            raise SourceError(f"eth_call invalide: {result}")
        return int(result, 16)

    def transfer_logs(self, address: str, start_block: int, end_block: int) -> list[dict[str, Any]]:
        if start_block > end_block:
            return []
        logs: list[dict[str, Any]] = []
        seen: set[tuple[str, int]] = set()
        page = 1
        while True:
            result = self.call(
                {
                    "module": "logs",
                    "action": "getLogs",
                    "address": address,
                    "topic0": TRANSFER_TOPIC,
                    "fromBlock": start_block,
                    "toBlock": end_block,
                    "page": page,
                    "offset": PAGE_SIZE,
                }
            )
            if isinstance(result, str):
                if "no records" in result.lower():
                    break
                raise SourceError(f"getLogs invalide: {result}")
            if not isinstance(result, list):
                raise SourceError("getLogs n'a pas renvoyé une liste")
            for raw_log in result:
                if not isinstance(raw_log, dict):
                    continue
                key = (str(raw_log.get("transactionHash", "")), parse_int(raw_log.get("logIndex", 0)))
                if key not in seen:
                    seen.add(key)
                    logs.append(raw_log)
            if len(result) < PAGE_SIZE:
                break
            page += 1
            if page > 500:
                raise SourceError("Pagination Etherscan anormalement longue")
        logs.sort(key=lambda item: (parse_int(item.get("blockNumber", 0)), parse_int(item.get("logIndex", 0))))
        return logs


def parse_int(value: Any) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return int(value, 16) if value.startswith("0x") else int(value)
    return int(value)


def address_from_topic(topic: str) -> str:
    return "0x" + topic[-40:].lower()


def apply_log(balances: dict[str, int], log: dict[str, Any], *, reverse: bool = False) -> None:
    topics = log.get("topics")
    if not isinstance(topics, list) or len(topics) < 3:
        raise SourceError("Log Transfer sans topics from/to")
    from_address = address_from_topic(str(topics[1]))
    to_address = address_from_topic(str(topics[2]))
    amount = parse_int(log.get("data", 0))
    direction = -1 if reverse else 1

    if from_address != ZERO_ADDRESS:
        balances[from_address] = balances.get(from_address, 0) - direction * amount
    if to_address != ZERO_ADDRESS:
        balances[to_address] = balances.get(to_address, 0) + direction * amount


def clean_balances(balances: dict[str, int]) -> dict[str, int]:
    negatives = [address for address, balance in balances.items() if balance < 0]
    if negatives:
        raise SourceError(
            f"État Ethereum incohérent: {len(negatives)} balance(s) négative(s)"
        )
    return {address: balance for address, balance in balances.items() if balance > 0}


def snapshot_dates(now: datetime) -> list[date]:
    today = now.date()
    return [today - timedelta(days=2), today - timedelta(days=1), today]


def snapshot_blocks(client: EtherscanClient, now: datetime, target_block: int) -> dict[str, int]:
    result: dict[str, int] = {}
    dates = snapshot_dates(now)
    for day in dates:
        if day == now.date():
            result[day.isoformat()] = target_block
        else:
            end_of_day = datetime.combine(day, dt_time(23, 59, 59), tzinfo=timezone.utc)
            result[day.isoformat()] = client.block_by_timestamp(int(end_of_day.timestamp()))
    return result


def load_state(path: str) -> dict[str, Any]:
    state = load_json(path, {})
    if not state:
        return {}
    if not isinstance(state, dict) or not isinstance(state.get("balances"), dict):
        raise DataFileError(f"État Ethereum invalide: {path}")
    return state


def convert_legacy_state(
    client: EtherscanClient,
    token: EthereumToken,
    state: dict[str, Any],
    window_start_block: int,
    target_block: int,
) -> tuple[int, dict[str, int], list[dict[str, Any]]]:
    """Convert original {last_block, balances-at-last_block} state to a rolling base."""
    last_block = parse_int(state["last_block"])
    if last_block > target_block:
        raise SourceError("Le state Ethereum est en avance sur Etherscan")
    latest_balances = {address.lower(): int(value) for address, value in state["balances"].items()}
    fetch_start = min(window_start_block, last_block + 1)
    all_logs = client.transfer_logs(token.address, fetch_start, target_block)

    for log in all_logs:
        if parse_int(log["blockNumber"]) > last_block:
            apply_log(latest_balances, log)
    latest_balances = clean_balances(latest_balances)

    window_logs = [log for log in all_logs if parse_int(log["blockNumber"]) >= window_start_block]
    base_balances = dict(latest_balances)
    for log in reversed(window_logs):
        apply_log(base_balances, log, reverse=True)
    base_balances = clean_balances(base_balances)
    return window_start_block - 1, base_balances, window_logs


def replay_holder_snapshots(
    client: EtherscanClient,
    token: EthereumToken,
    state: dict[str, Any],
    blocks: dict[str, int],
    target_block: int,
) -> tuple[list[dict[str, Any]], dict[str, Any], int]:
    window_start = min(blocks.values())

    if state.get("version") == 2 and "base_block" in state:
        base_block = parse_int(state["base_block"])
        if base_block >= window_start:
            raise SourceError("Checkpoint Ethereum trop récent pour recalculer trois jours")
        balances = {address.lower(): int(value) for address, value in state["balances"].items()}
        logs = client.transfer_logs(token.address, base_block + 1, target_block)
    elif state.get("last_block") is not None:
        base_block, balances, logs = convert_legacy_state(
            client, token, state, window_start, target_block
        )
    else:
        raise SourceError(
            f"{token.state_file} absent: le holder count free tier exige le checkpoint existant; "
            "aucun replay complet automatique n'est lancé"
        )

    ordered_snapshots = sorted(blocks.items(), key=lambda item: item[1])
    points: list[dict[str, Any]] = []
    log_index = 0
    new_base_balances: dict[str, int] | None = None
    new_base_block = window_start - 1

    # Advance from an older rolling base and retain balances immediately before
    # the new three-day window for the next run.
    while log_index < len(logs) and parse_int(logs[log_index]["blockNumber"]) <= new_base_block:
        apply_log(balances, logs[log_index])
        log_index += 1
    new_base_balances = clean_balances(dict(balances))

    for day, block in ordered_snapshots:
        while log_index < len(logs) and parse_int(logs[log_index]["blockNumber"]) <= block:
            apply_log(balances, logs[log_index])
            log_index += 1
        balances = clean_balances(balances)
        points.append({"date": day, "holders": len(balances)})

    new_state = {
        "version": 2,
        "base_block": new_base_block,
        "last_block": target_block,
        "balances": {address: str(value) for address, value in new_base_balances.items()},
    }
    return points, new_state, sum(balances.values())


def supply_snapshots(
    client: EtherscanClient,
    token: EthereumToken,
    blocks: dict[str, int],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    decimals = client.eth_call(token.address, DECIMALS_SELECTOR, max(blocks.values()))
    if decimals < 0 or decimals > 36:
        raise SourceError(f"Decimals Ethereum invalides: {decimals}")
    divisor = 10**decimals
    points = []
    raw_by_day: dict[str, int] = {}
    for day, block in sorted(blocks.items(), key=lambda item: item[0]):
        raw_supply = client.eth_call(token.address, TOTAL_SUPPLY_SELECTOR, block)
        raw_by_day[day] = raw_supply
        points.append({"date": day, "supply": raw_supply / divisor})
    return points, raw_by_day


def run_ethereum(token: EthereumToken, *, now: datetime | None = None) -> dict[str, bool]:
    now = now or datetime.now(timezone.utc)
    api_key = os.environ.get("ETHERSCAN_API_KEY", "")
    status = {"holders": False, "supply": False, "state": False}
    raw_supply_by_day: dict[str, int] = {}

    try:
        client = EtherscanClient(api_key)
        target_block = client.current_block()
        blocks = snapshot_blocks(client, now, target_block)
    except Exception as exc:
        print(f"[{token.name}] Etherscan indisponible: {exc}")
        return status

    try:
        existing_supply = load_history(
            token.supply_file, HistorySpec("supply", token.supply_precision)
        )
        new_supply, raw_supply_by_day = supply_snapshots(client, token, blocks)
        merged_supply = upsert_daily_points(
            existing_supply,
            new_supply,
            HistorySpec("supply", token.supply_precision),
            preserve_marketcap_shape=token.legacy_marketcap_shape,
        )
        atomic_write_json(token.supply_file, merged_supply)
        status["supply"] = True
        print(f"[{token.name}] supply: {len(new_supply)} date(s) actualisée(s)")
    except Exception as exc:
        print(f"[{token.name}] supply conservée sans modification: {exc}")

    try:
        existing_holders = load_history(token.holders_file, HistorySpec("holders", 0))
        state = load_state(token.state_file)
        holder_points, new_state, latest_balance_sum = replay_holder_snapshots(
            client, token, state, blocks, target_block
        )
        current_day = max(blocks, key=blocks.get)
        expected_supply = raw_supply_by_day.get(current_day)
        if expected_supply is None:
            expected_supply = client.eth_call(
                token.address, TOTAL_SUPPLY_SELECTOR, target_block
            )
        if latest_balance_sum != expected_supply:
            raise SourceError(
                "Checkpoint holders incohérent avec totalSupply au bloc "
                f"{target_block}: balances={latest_balance_sum}, "
                f"totalSupply={expected_supply}"
            )
        merged_holders = upsert_daily_points(
            existing_holders, holder_points, HistorySpec("holders", 0)
        )
        # Write history first, checkpoint second. If state write fails, the next run
        # can still reconstruct from the previous checkpoint and canonical logs.
        atomic_write_json(token.holders_file, merged_holders)
        status["holders"] = True
        atomic_write_json(token.state_file, new_state)
        status["state"] = True
        print(f"[{token.name}] holders: {len(holder_points)} date(s) actualisée(s)")
    except Exception as exc:
        print(f"[{token.name}] holders conservés sans modification: {exc}")

    return status
