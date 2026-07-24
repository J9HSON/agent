from __future__ import annotations

import argparse
import base64
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import time

from smart_neckband.health_contract import load_health_contract
from smart_neckband.health_state import BuiltHealthState
from smart_neckband.health_store import HealthStore
from smart_neckband.health_webhook import (
    HealthWebhookClient,
    HealthWebhookDispatcher,
    parse_secret_hex,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create one isolated live Health event and deliver it to a test receiver."
    )
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--wearer-id", required=True)
    parser.add_argument("--webhook-url", required=True)
    parser.add_argument("--key-id", required=True)
    parser.add_argument("--secret-hex", required=True)
    args = parser.parse_args()

    document = deepcopy(load_health_contract()["x-golden"]["wearer_state_live"])
    document["wearer_id"] = args.wearer_id
    document["signal"].update(
        {
            "lead_off": True,
            "quality_score": 0.1,
            "quality_level": "bad",
            "quality_rank": 1,
        }
    )
    for metric in document["heart"].values():
        if isinstance(metric, dict) and "valid" in metric:
            metric.update(
                {
                    "value": None,
                    "valid": False,
                    "observed_at": None,
                    "age_ms": None,
                    "unavailable_reason": "lead_off",
                }
            )

    now_ns = time.monotonic_ns()
    built = BuiltHealthState(
        document=document,
        committed_monotonic_ns=now_ns,
        ecg_received_monotonic_ns=now_ns - int(document["age_ms"]) * 1_000_000,
        transport_received_monotonic_ns=now_ns
        - int(document["device"]["last_transport_packet_age_ms"]) * 1_000_000,
        status_evidence_key="cross-repo-integration",
        clipping_window_full=True,
    )
    store = HealthStore(args.db)
    committed = store.commit_state(built)
    pending = store.list_outbox()
    if len(pending) != 1:
        raise RuntimeError(f"expected one production Health outbox item, got {len(pending)}")
    item = pending[0]

    client = HealthWebhookClient(
        url=args.webhook_url,
        key_id=args.key_id,
        secret=parse_secret_hex(args.secret_hex),
    )
    dispatcher = HealthWebhookDispatcher(store=store, client=client)
    if not dispatcher.run_once():
        raise RuntimeError("Health webhook dispatcher did not claim the seeded notification")

    with sqlite3.connect(args.db) as connection:
        delivered = connection.execute(
            """
            SELECT http_status, attempt_count
            FROM health_webhook_deliveries
            WHERE notification_id=?
            """,
            (item["notification_id"],),
        ).fetchone()
    if delivered is None:
        raise RuntimeError("seeded Health notification was not recorded as delivered")

    event = committed["active_events"][0]
    print(
        json.dumps(
            {
                "notification_id": item["notification_id"],
                "event_id": event["event_id"],
                "event_revision": event["event_revision"],
                "state_revision": committed["state_revision"],
                "raw_body_base64": base64.b64encode(item["raw_body"]).decode("ascii"),
                "raw_body_sha256": item["raw_body_sha256"],
                "raw_body_byte_length": len(item["raw_body"]),
                "http_status": delivered[0],
                "attempt_count": delivered[1],
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
