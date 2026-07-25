"""Machine-auditable Stage 2 semantic navigation checks.

The preflight path is read-only.  A trip is sent only after the caller provides
the explicit motion acknowledgement, and this client never retries a movement
tool.  Timeout handling issues one canonical cancellation and records whether
navigation became idle.
"""

from __future__ import annotations

import argparse
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
import json
import math
from pathlib import Path
import re
import sys
import time
from typing import Any, Protocol
from uuid import uuid4


MOTION_ACKNOWLEDGEMENT = "START GO2，场地已清空"
DEFAULT_ENDPOINT = "http://127.0.0.1:9990/mcp"
DEFAULT_TIMEOUT_S = 300.0
DEFAULT_POLL_INTERVAL_S = 0.25
MAX_ARRIVAL_ERROR_M = 0.60
TERMINAL_STATES = frozenset({"completed", "failed", "cancelled"})
REQUIRED_TOOLS = frozenset(
    {
        "server_status",
        "get_robot_summary",
        "get_task_status",
        "list_semantic_places",
        "start_task",
        "cancel_task",
        "stop_all",
    }
)


class Stage2AuditError(RuntimeError):
    """A fail-closed precondition or MCP contract violation."""


class Stage2McpClient(Protocol):
    """Small client boundary used by both the live CLI and deterministic tests."""

    def list_tools(self) -> list[dict[str, Any]]: ...

    def call_tool_text(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
    ) -> str: ...


class Stage2Audit:
    """Read and execute one canonical Stage 2 trip with structured evidence."""

    def __init__(
        self,
        client: Stage2McpClient,
        *,
        monotonic_clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
        wall_clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        poll_interval_s: float = DEFAULT_POLL_INTERVAL_S,
    ) -> None:
        if poll_interval_s <= 0:
            raise ValueError("poll_interval_s must be positive")
        self._client = client
        self._monotonic_clock = monotonic_clock
        self._sleeper = sleeper
        self._wall_clock = wall_clock
        self._poll_interval_s = poll_interval_s

    def preflight(
        self,
        *,
        required_places: Sequence[str] = (),
    ) -> dict[str, Any]:
        """Prove that one product Runtime is fresh, relocalized and idle."""

        tool_names = {
            item.get("name")
            for item in self._client.list_tools()
            if isinstance(item, dict)
        }
        missing_tools = sorted(REQUIRED_TOOLS - tool_names)
        if missing_tools:
            raise Stage2AuditError(f"missing required MCP tools: {missing_tools}")

        runtime = self._tool_json("server_status")
        if runtime.get("mode") != "go2":
            raise Stage2AuditError("runtime mode must be go2")
        if runtime.get("tool_profile") != "product":
            raise Stage2AuditError("runtime tool profile must be product")
        pid = runtime.get("pid")
        owner = runtime.get("runtime_owner")
        if (
            not isinstance(pid, int)
            or not isinstance(owner, dict)
            or owner.get("pid") != pid
            or owner.get("mode") != "go2"
        ):
            raise Stage2AuditError("runtime owner PID is missing or inconsistent")
        if not isinstance(runtime.get("robot_ip"), str) or not runtime["robot_ip"].strip():
            raise Stage2AuditError("runtime robot IP is missing")

        summary = self._tool_json("get_robot_summary")
        odometry = summary.get("odometry")
        if (
            summary.get("status") != "ready"
            or not isinstance(odometry, dict)
            or odometry.get("available") is not True
            or odometry.get("fresh") is not True
        ):
            raise Stage2AuditError("fresh odometry is not ready")
        relocalization = summary.get("relocalization")
        if (
            not isinstance(relocalization, dict)
            or relocalization.get("required") is not True
            or relocalization.get("ready") is not True
        ):
            reason = (
                relocalization.get("reason")
                if isinstance(relocalization, dict)
                else "missing"
            )
            raise Stage2AuditError(
                f"relocalization is not ready: {reason}"
            )
        stable_pose = _pose(summary.get("stable_pose"), label="stable_pose")
        if stable_pose["frame_id"] != relocalization.get("stable_frame_id"):
            raise Stage2AuditError(
                "stable pose frame does not match relocalization frame"
            )

        task_status = self._tool_json("get_task_status")
        if task_status.get("active") is True:
            raise Stage2AuditError("another canonical task is active")
        state = task_status.get("state")
        if state != "idle" and state not in TERMINAL_STATES:
            raise Stage2AuditError(
                f"canonical task is not idle or terminal: {state!r}"
            )

        semantic = self._tool_json("list_semantic_places")
        map_id = semantic.get("map_id")
        map_version = semantic.get("map_version")
        if (
            not isinstance(map_id, str)
            or not map_id.strip()
            or not isinstance(map_version, str)
            or not map_version.strip()
        ):
            raise Stage2AuditError("semantic map ID/version is missing")
        places_raw = semantic.get("places")
        if not isinstance(places_raw, list):
            raise Stage2AuditError("semantic place list is missing")
        places = [
            item for item in places_raw if isinstance(item, dict)
        ]
        for place in places:
            if place.get("map_id") != map_id or place.get("map_version") != map_version:
                raise Stage2AuditError("semantic place map ID/version is inconsistent")
            place_pose = _pose(place.get("pose"), label="semantic place pose")
            if place_pose["frame_id"] != stable_pose["frame_id"]:
                raise Stage2AuditError("semantic place is not in the stable map frame")
        for requested in required_places:
            _find_place(places, requested)

        return {
            "passed": True,
            "checked_at": _iso(self._wall_clock()),
            "runtime": runtime,
            "robot_summary": summary,
            "task_status": task_status,
            "map": {
                "map_id": map_id,
                "map_version": map_version,
                "stable_frame_id": stable_pose["frame_id"],
            },
            "places": places,
        }

    def run_trip(
        self,
        *,
        destination: str,
        task_id: str,
        acknowledgement: str,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ) -> dict[str, Any]:
        """Run exactly one named-place mission and return audit evidence."""

        if acknowledgement != MOTION_ACKNOWLEDGEMENT:
            raise Stage2AuditError(
                "exact motion acknowledgement is required before a trip"
            )
        if timeout_s <= 0:
            raise ValueError("timeout_s must be positive")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}", task_id):
            raise ValueError("task_id does not match the canonical contract")

        preflight = self.preflight(required_places=(destination,))
        place = _find_place(preflight["places"], destination)
        canonical_destination = str(place["name"])
        target_pose = _pose(place.get("pose"), label="destination pose")
        started_at = self._wall_clock()
        task = {
            "task_id": task_id,
            "kind": "go_to_place",
            "destination": canonical_destination,
            "created_at": _iso(started_at),
        }
        accepted = self._tool_json(
            "start_task",
            {"task_json": json.dumps(task, ensure_ascii=False)},
        )
        if accepted.get("accepted") is not True:
            raise Stage2AuditError(
                f"start_task was rejected: {accepted.get('reason', 'unknown')}"
            )
        if accepted.get("task_id") != task_id:
            self._best_effort_stop()
            raise Stage2AuditError("start_task returned a different task ID")

        deadline = self._monotonic_clock() + timeout_s
        timeline: list[dict[str, Any]] = []
        terminal: dict[str, Any] | None = None
        while self._monotonic_clock() < deadline:
            snapshot = self._tool_json("get_task_status")
            snapshot_task = snapshot.get("task")
            observed_task_id = (
                snapshot_task.get("task_id")
                if isinstance(snapshot_task, dict)
                else None
            )
            if observed_task_id != task_id:
                self._best_effort_stop()
                raise Stage2AuditError(
                    f"task status ID mismatch: {observed_task_id!r}"
                )
            timeline.append(
                {
                    "observed_at": _iso(self._wall_clock()),
                    "elapsed_s": round(
                        max(
                            0.0,
                            timeout_s - (deadline - self._monotonic_clock()),
                        ),
                        3,
                    ),
                    "state": snapshot.get("state"),
                    "active": snapshot.get("active"),
                    "snapshot": snapshot,
                }
            )
            if snapshot.get("state") in TERMINAL_STATES:
                terminal = snapshot
                break
            self._sleeper(self._poll_interval_s)

        timed_out = terminal is None
        navigation_idle: bool | None = None
        if timed_out:
            terminal = self._tool_json("cancel_task", {"task_id": task_id})
            navigation_idle = terminal.get("navigation_idle") is True

        end_summary = self._tool_json("get_robot_summary")
        end_pose = _pose(end_summary.get("stable_pose"), label="final stable_pose")
        arrival_error_m = math.dist(
            (float(target_pose["x"]), float(target_pose["y"])),
            (float(end_pose["x"]), float(end_pose["y"])),
        )
        failures: list[str] = []
        if timed_out:
            failures.append("mission_timeout")
        if terminal.get("state") != "completed":
            failures.append(f"terminal_state:{terminal.get('state')}")
        if terminal.get("active") is True:
            failures.append("terminal_task_still_active")
        if target_pose["frame_id"] != end_pose["frame_id"]:
            failures.append("arrival_frame_mismatch")
        if arrival_error_m > MAX_ARRIVAL_ERROR_M:
            failures.append("arrival_error_exceeded")
        if end_summary.get("observed_motion_state") != "stationary":
            failures.append("robot_not_stationary")
        relocalization = end_summary.get("relocalization")
        if not isinstance(relocalization, dict) or relocalization.get("ready") is not True:
            failures.append("relocalization_lost")
        if timed_out and navigation_idle is not True:
            failures.append("cancel_not_idle")

        return {
            "schema_version": 1,
            "passed": not failures,
            "checked_at": _iso(self._wall_clock()),
            "task_id": task_id,
            "destination": canonical_destination,
            "map_id": place.get("map_id"),
            "map_version": place.get("map_version"),
            "target_pose": target_pose,
            "terminal_state": terminal.get("state"),
            "navigation_idle": navigation_idle,
            "arrival_error_m": round(arrival_error_m, 4),
            "arrival_threshold_m": MAX_ARRIVAL_ERROR_M,
            "failures": failures,
            "accepted": accepted,
            "task_timeline": timeline,
            "terminal_snapshot": terminal,
            "start_summary": preflight["robot_summary"],
            "end_summary": end_summary,
            "preflight": preflight,
        }

    def run_cancel_check(
        self,
        *,
        destination: str,
        task_id: str,
        acknowledgement: str,
        navigation_wait_s: float = 10.0,
    ) -> dict[str, Any]:
        """Start one mission, cancel after navigation begins, and prove idle."""

        if acknowledgement != MOTION_ACKNOWLEDGEMENT:
            raise Stage2AuditError(
                "exact motion acknowledgement is required before a cancel check"
            )
        if navigation_wait_s <= 0:
            raise ValueError("navigation_wait_s must be positive")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}", task_id):
            raise ValueError("task_id does not match the canonical contract")

        preflight = self.preflight(required_places=(destination,))
        place = _find_place(preflight["places"], destination)
        canonical_destination = str(place["name"])
        task = {
            "task_id": task_id,
            "kind": "go_to_place",
            "destination": canonical_destination,
            "created_at": _iso(self._wall_clock()),
        }
        accepted = self._tool_json(
            "start_task",
            {"task_json": json.dumps(task, ensure_ascii=False)},
        )
        if accepted.get("accepted") is not True:
            raise Stage2AuditError(
                f"start_task was rejected: {accepted.get('reason', 'unknown')}"
            )
        if accepted.get("task_id") != task_id:
            self._best_effort_stop()
            raise Stage2AuditError("start_task returned a different task ID")

        deadline = self._monotonic_clock() + navigation_wait_s
        timeline: list[dict[str, Any]] = []
        navigation_started = False
        while self._monotonic_clock() < deadline:
            snapshot = self._tool_json("get_task_status")
            _require_task_id(snapshot, task_id)
            state = snapshot.get("state")
            timeline.append(
                {
                    "observed_at": _iso(self._wall_clock()),
                    "state": state,
                    "active": snapshot.get("active"),
                    "snapshot": snapshot,
                }
            )
            if state in {"navigating", "recovering"}:
                navigation_started = True
                break
            if state in TERMINAL_STATES:
                break
            self._sleeper(self._poll_interval_s)

        cancelled = self._tool_json("cancel_task", {"task_id": task_id})
        final_status = self._tool_json("get_task_status")
        end_summary = self._tool_json("get_robot_summary")
        failures: list[str] = []
        try:
            _require_task_id(cancelled, task_id)
        except Stage2AuditError:
            failures.append("cancel_task_id_mismatch")
        try:
            _require_task_id(final_status, task_id)
        except Stage2AuditError:
            failures.append("final_task_id_mismatch")
        if not navigation_started:
            failures.append("navigation_never_started")
        if cancelled.get("state") != "cancelled":
            failures.append(f"cancel_terminal_state:{cancelled.get('state')}")
        if cancelled.get("navigation_idle") is not True:
            failures.append("cancel_not_idle")
        if final_status.get("state") != "cancelled":
            failures.append(f"final_state:{final_status.get('state')}")
        if final_status.get("active") is True:
            failures.append("final_task_still_active")
        if end_summary.get("observed_motion_state") != "stationary":
            failures.append("robot_not_stationary")

        return {
            "schema_version": 1,
            "kind": "cancel_check",
            "passed": not failures,
            "checked_at": _iso(self._wall_clock()),
            "task_id": task_id,
            "destination": canonical_destination,
            "navigation_started": navigation_started,
            "terminal_state": cancelled.get("state"),
            "navigation_idle": cancelled.get("navigation_idle"),
            "failures": failures,
            "accepted": accepted,
            "task_timeline": timeline,
            "cancel_snapshot": cancelled,
            "final_task_status": final_status,
            "end_summary": end_summary,
            "preflight": preflight,
        }

    def _best_effort_stop(self) -> None:
        try:
            self._client.call_tool_text("stop_all", {})
        except Exception:
            pass

    def _tool_json(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        raw = self._client.call_tool_text(name, arguments)
        try:
            payload = json.loads(raw)
        except (json.JSONDecodeError, TypeError) as exc:
            raise Stage2AuditError(f"{name} returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise Stage2AuditError(f"{name} returned a non-object payload")
        return payload


def _find_place(
    places: Sequence[dict[str, Any]],
    requested: str,
) -> dict[str, Any]:
    key = _label_key(requested)
    matches = [
        place
        for place in places
        if key
        in {
            _label_key(str(place.get("name", ""))),
            *(
                _label_key(str(alias))
                for alias in place.get("aliases", [])
                if isinstance(place.get("aliases"), list)
            ),
        }
    ]
    if len(matches) != 1:
        raise Stage2AuditError(
            f"expected exactly one semantic place for {requested!r}; got {len(matches)}"
        )
    return matches[0]


def _require_task_id(snapshot: dict[str, Any], task_id: str) -> None:
    task = snapshot.get("task")
    observed = task.get("task_id") if isinstance(task, dict) else None
    if observed != task_id:
        raise Stage2AuditError(f"task status ID mismatch: {observed!r}")


def _pose(value: object, *, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise Stage2AuditError(f"{label} is missing")
    required = ("frame_id", "x", "y")
    if any(field not in value for field in required):
        raise Stage2AuditError(f"{label} is incomplete")
    if not isinstance(value["frame_id"], str) or not value["frame_id"].strip():
        raise Stage2AuditError(f"{label} frame is invalid")
    for field in ("x", "y"):
        coordinate = value[field]
        if isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)):
            raise Stage2AuditError(f"{label} {field} is not numeric")
        if not math.isfinite(float(coordinate)):
            raise Stage2AuditError(f"{label} {field} is not finite")
    return dict(value)


def _label_key(value: str) -> str:
    return "".join(value.split()).casefold()


def _iso(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("wall clock must return timezone-aware datetime")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _write_report(directory: Path, name: str, report: dict[str, Any]) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.json"
    temp = path.with_suffix(".json.tmp")
    temp.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temp.replace(path)
    return path


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run machine-auditable Stage 2 semantic-navigation checks.",
    )
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument(
        "--evidence-dir",
        type=Path,
        default=Path("~/.dimos/go2-stage2/evidence").expanduser(),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    preflight = subparsers.add_parser("preflight", help="read-only readiness check")
    preflight.add_argument("--place", action="append", default=[])

    trip = subparsers.add_parser("trip", help="run exactly one semantic trip")
    trip.add_argument("--destination", required=True)
    trip.add_argument("--task-id", default=f"task-stage2-{uuid4().hex}")
    trip.add_argument("--timeout-s", type=float, default=DEFAULT_TIMEOUT_S)
    trip.add_argument("--acknowledge-motion", required=True)

    cancel = subparsers.add_parser(
        "cancel-check",
        help="start one semantic trip, cancel it, and prove navigation idle",
    )
    cancel.add_argument("--destination", required=True)
    cancel.add_argument("--task-id", default=f"task-stage2-{uuid4().hex}")
    cancel.add_argument("--navigation-wait-s", type=float, default=10.0)
    cancel.add_argument("--acknowledge-motion", required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point; preflight is read-only and trip is explicitly gated."""

    args = _parser().parse_args(argv)
    from dimos.agents.mcp.mcp_adapter import McpAdapter

    client = McpAdapter(url=args.endpoint)
    if not client.wait_for_ready(timeout=3.0):
        print(
            f"Stage 2 audit failed: MCP endpoint is not ready: {args.endpoint}",
            file=sys.stderr,
        )
        return 2
    audit = Stage2Audit(client)
    try:
        if args.command == "preflight":
            report = audit.preflight(required_places=tuple(args.place))
            name = f"preflight-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
        elif args.command == "trip":
            report = audit.run_trip(
                destination=args.destination,
                task_id=args.task_id,
                acknowledgement=args.acknowledge_motion,
                timeout_s=args.timeout_s,
            )
            name = args.task_id
        else:
            report = audit.run_cancel_check(
                destination=args.destination,
                task_id=args.task_id,
                acknowledgement=args.acknowledge_motion,
                navigation_wait_s=args.navigation_wait_s,
            )
            name = args.task_id
    except (Stage2AuditError, ValueError) as exc:
        print(f"Stage 2 audit failed: {exc}", file=sys.stderr)
        return 2

    path = _write_report(args.evidence_dir, name, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"evidence: {path}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
