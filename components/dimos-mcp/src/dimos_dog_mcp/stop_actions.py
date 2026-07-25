"""Pure orchestration for best-effort unified stopping."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
import json


STOP_COMPONENT_NAMES = (
    "mission",
    "exploration",
    "patrol",
    "stroll",
    "follow",
    "lookout",
    "navigation",
    "motion",
)

StopAction = tuple[str, Callable[[], object]]


def run_stop_actions(actions: Iterable[StopAction]) -> str:
    """Attempt every configured stop action and return one structured result."""

    results: dict[str, dict[str, object]] = {
        name: {"status": "not_configured"} for name in STOP_COMPONENT_NAMES
    }
    failed_components: list[str] = []
    for name, action in actions:
        try:
            result = action()
        except Exception as error:
            failed_components.append(name)
            results[name] = {"status": "error", "error": str(error)}
        else:
            reported_error = _reported_error(result)
            if reported_error is None:
                results[name] = {"status": "success", "result": result}
            else:
                failed_components.append(name)
                results[name] = {
                    "status": "error",
                    "error": reported_error,
                    "result": result,
                }

    return json.dumps(
        {
            "status": "error" if failed_components else "stopped",
            "failed_components": failed_components,
            "results": results,
        },
        ensure_ascii=False,
    )


def _reported_error(result: object) -> str | None:
    payload: object = result
    if isinstance(result, str):
        try:
            payload = json.loads(result)
        except json.JSONDecodeError:
            return None
    if not isinstance(payload, Mapping) or payload.get("status") != "error":
        return None
    error = payload.get("error")
    return error if isinstance(error, str) else "stop action reported an error"
