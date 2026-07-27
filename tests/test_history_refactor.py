from decimal import Decimal

from scripts.stablecoin_history.etherscan import (
    EthereumToken,
    apply_log,
    replay_holder_snapshots,
)
from scripts.stablecoin_history.solscan import normalize_solscan_supply
from scripts.stablecoin_history.storage import HistorySpec, upsert_daily_points


def topic(address: str) -> str:
    return "0x" + ("0" * 24) + address.removeprefix("0x").lower()


def transfer(block: int, index: int, sender: str, recipient: str, amount: int):
    return {
        "blockNumber": hex(block),
        "logIndex": hex(index),
        "transactionHash": f"0x{block:062x}{index:02x}",
        "topics": ["0xtransfer", topic(sender), topic(recipient)],
        "data": hex(amount),
    }


def test_upsert_preserves_old_history_and_shape():
    old = [
        {"date": "2026-07-20", "holders": 10},
        {"date": "2026-07-21", "holders": 11},
    ]
    result = upsert_daily_points(
        old,
        [
            {"date": "2026-07-21", "holders": 12},
            {"date": "2026-07-22", "holders": 13},
        ],
        HistorySpec("holders", 0),
    )
    assert result == [
        {"date": "2026-07-20", "holders": 10},
        {"date": "2026-07-21", "holders": 12},
        {"date": "2026-07-22", "holders": 13},
    ]


def test_upsert_does_not_collapse_untouched_legacy_duplicates():
    old = [
        {"date": "2026-07-20", "holders": 10, "legacy": "a"},
        {"date": "2026-07-20", "holders": 10, "legacy": "b"},
        {"date": "2026-07-22", "holders": 12},
    ]
    result = upsert_daily_points(
        old,
        [{"date": "2026-07-21", "holders": 11}],
        HistorySpec("holders", 0),
    )
    assert result == [
        {"date": "2026-07-20", "holders": 10, "legacy": "a"},
        {"date": "2026-07-20", "holders": 10, "legacy": "b"},
        {"date": "2026-07-21", "holders": 11},
        {"date": "2026-07-22", "holders": 12},
    ]


def test_marketcap_legacy_shape_is_preserved_without_fx():
    old = [{"date": "2026-07-20", "marketcap": 100.5, "supply": 90.0}]
    result = upsert_daily_points(
        old,
        [{"date": "2026-07-21", "supply": 91.25}],
        HistorySpec("supply", 2),
        preserve_marketcap_shape=True,
    )
    assert result[-1] == {"date": "2026-07-21", "marketcap": 91.25, "supply": 91.25}
    assert result[0] == old[0]


def test_solscan_supply_selects_raw_or_scaled_from_continuity():
    assert normalize_solscan_supply("123000000", 6, Decimal("122")) == Decimal("123")
    assert normalize_solscan_supply("123", 6, Decimal("122")) == Decimal("123")


def test_apply_transfer_and_reverse_are_exact():
    zero = "0x" + "0" * 40
    alice = "0x" + "1" * 40
    bob = "0x" + "2" * 40
    balances = {alice: 100}
    log = transfer(10, 0, alice, bob, 25)
    apply_log(balances, log)
    assert balances == {alice: 75, bob: 25}
    apply_log(balances, log, reverse=True)
    assert balances == {alice: 100, bob: 0}


class FakeEtherscanClient:
    def __init__(self, logs):
        self.logs = logs
        self.calls = []

    def transfer_logs(self, address, start_block, end_block):
        self.calls.append((address, start_block, end_block))
        return [
            log
            for log in self.logs
            if start_block <= int(log["blockNumber"], 16) <= end_block
        ]


def test_v2_checkpoint_replays_only_window_and_returns_three_holder_points():
    zero = "0x" + "0" * 40
    alice = "0x" + "1" * 40
    bob = "0x" + "2" * 40
    carol = "0x" + "3" * 40
    logs = [
        transfer(101, 0, alice, bob, 20),
        transfer(111, 0, zero, carol, 50),
        transfer(121, 0, bob, zero, 20),
    ]
    client = FakeEtherscanClient(logs)
    token = EthereumToken("test", "0xtoken", "h.json", "s.json", "state.json", 2)
    state = {
        "version": 2,
        "base_block": 100,
        "last_block": 100,
        "balances": {alice: "100"},
    }
    points, new_state, latest_balance_sum = replay_holder_snapshots(
        client,
        token,
        state,
        {"2026-07-20": 110, "2026-07-21": 120, "2026-07-22": 130},
        130,
    )
    assert points == [
        {"date": "2026-07-20", "holders": 2},
        {"date": "2026-07-21", "holders": 3},
        {"date": "2026-07-22", "holders": 2},
    ]
    assert client.calls == [("0xtoken", 101, 130)]
    assert new_state["base_block"] == 109
    assert new_state["balances"] == {alice: "80", bob: "20"}
    assert latest_balance_sum == 130


def test_solscan_corrupt_holders_does_not_block_supply(tmp_path, monkeypatch):
    import json
    from datetime import datetime, timezone
    from scripts.stablecoin_history import solscan as solscan_module

    holders_file = tmp_path / "holders.json"
    supply_file = tmp_path / "supply.json"
    holders_file.write_text("{broken", encoding="utf-8")
    supply_file.write_text(
        json.dumps([{"date": "2026-07-20", "supply": 122}]), encoding="utf-8"
    )

    class FakeClient:
        def __init__(self, api_key):
            pass

        def token_meta(self, mint):
            return {"address": mint, "holder": 20, "decimals": 6, "supply": "123000000"}

    monkeypatch.setattr(solscan_module, "SolscanClient", FakeClient)
    token = solscan_module.SolanaToken(
        "test", "mint", str(holders_file), str(supply_file), 2
    )
    status = solscan_module.run_solscan(
        token, now=datetime(2026, 7, 21, 12, tzinfo=timezone.utc)
    )

    assert status == {"holders": False, "supply": True}
    assert holders_file.read_text(encoding="utf-8") == "{broken"
    assert json.loads(supply_file.read_text(encoding="utf-8"))[-1] == {
        "date": "2026-07-21",
        "supply": 123,
    }


def test_ethereum_missing_state_keeps_holders_but_updates_supply(tmp_path, monkeypatch):
    import json
    from datetime import datetime, timezone
    from scripts.stablecoin_history import etherscan as etherscan_module

    holders_file = tmp_path / "holders.json"
    supply_file = tmp_path / "supply.json"
    state_file = tmp_path / "missing_state.json"
    holders = [{"date": "2026-07-20", "holders": 10}]
    holders_file.write_text(json.dumps(holders), encoding="utf-8")
    supply_file.write_text(
        json.dumps([{"date": "2026-07-20", "supply": 100}]), encoding="utf-8"
    )

    class FakeClient:
        def __init__(self, api_key):
            pass

        def current_block(self):
            return 130

        def block_by_timestamp(self, timestamp):
            return 100 if timestamp % 2 == 0 else 110

        def eth_call(self, address, selector, block):
            if selector == etherscan_module.DECIMALS_SELECTOR:
                return 2
            return {100: 10000, 110: 10100, 130: 10200}[block]

    monkeypatch.setattr(etherscan_module, "EtherscanClient", FakeClient)
    token = etherscan_module.EthereumToken(
        "test",
        "0xtoken",
        str(holders_file),
        str(supply_file),
        str(state_file),
        2,
    )
    status = etherscan_module.run_ethereum(
        token, now=datetime(2026, 7, 22, 12, tzinfo=timezone.utc)
    )

    assert status == {"holders": False, "supply": True, "state": False}
    assert json.loads(holders_file.read_text(encoding="utf-8")) == holders
    supply = json.loads(supply_file.read_text(encoding="utf-8"))
    assert supply[-1] == {"date": "2026-07-22", "supply": 102}
