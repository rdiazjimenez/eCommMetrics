import csv
import io
import json
import logging
from datetime import datetime

import azure.functions as func

import config
import keyvault_client
import table_storage_client
from exceptions import MultiPlatformRunError
from platform_registry import REGISTRY

app = func.FunctionApp()

CSV_COLUMNS = [
    "snapshot_date",
    "video_id",
    "open_id",
    "title",
    "description",
    "create_time",
    "duration_sec",
    "view_count",
    "like_count",
    "comment_count",
    "share_count",
    "share_url",
    "cover_url",
    "fetched_at",
]


# ---------------------------------------------------------------------------
# Timer Trigger
# ---------------------------------------------------------------------------


@app.timer_trigger(
    schedule="%TIMER_SCHEDULE%",
    arg_name="timer",
    run_on_startup=False,
)
def timer_trigger(timer: func.TimerRequest) -> None:
    logging.info("ECommMetrics timer trigger fired.")
    failures: list[str] = []

    for platform_name in config.CONFIGURED_PLATFORMS:
        adapter_cls = REGISTRY.get(platform_name)
        if adapter_cls is None:
            logging.warning("No adapter registered for platform: %s", platform_name)
            failures.append(platform_name)
            continue

        account_id = "unknown"
        try:
            account_id, videos_count = adapter_cls().run()
            table_storage_client.write_run_status(
                platform_name, account_id, "ok", videos_count=videos_count
            )
            logging.info("%s: fetched %d videos.", platform_name, videos_count)
            logging.info("ECOMMMETRICS_RUN_SUCCESS platform=%s", platform_name)
        except Exception as exc:
            try:
                account_id = keyvault_client.read_token(f"{platform_name}-open-id")
            except Exception:
                pass
            table_storage_client.write_run_status(
                platform_name, account_id, "error", error_message=str(exc)
            )
            logging.error("%s failed: %s", platform_name, exc)
            failures.append(platform_name)

    if failures:
        raise MultiPlatformRunError(failures)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_account_id(platform: str, account_id: str | None) -> tuple[str | None, str | None]:
    if account_id:
        return account_id, None
    secret_name = f"{platform}-open-id"
    try:
        return keyvault_client.read_token(secret_name), None
    except Exception:
        return None, f"accountId required: could not resolve account for platform={platform}"


def _validate_stats_params(params: dict) -> tuple[dict | None, str | None]:
    platform = params.get("platform")
    if not platform:
        return None, "platform is required"
    if platform not in REGISTRY:
        return None, f"unknown platform: {platform}"

    view = params.get("view", "latest")
    if view not in ("latest", "history"):
        return None, f"invalid view: {view}"

    fmt = params.get("format", "csv")
    if fmt not in ("csv", "json"):
        return None, f"invalid format: {fmt}"

    from_date = params.get("from")
    to_date = params.get("to")
    for label, val in (("from", from_date), ("to", to_date)):
        if val:
            try:
                datetime.strptime(val, "%Y-%m-%d")
            except ValueError:
                return None, f"invalid {label} date: {val}"

    limit_raw = params.get("limit")
    limit: int | None = None
    if limit_raw is not None:
        try:
            limit = int(limit_raw)
            if limit < 1 or limit > 10000:
                raise ValueError()
        except ValueError:
            return None, "limit must be an integer between 1 and 10000"

    return {
        "platform": platform,
        "view": view,
        "format": fmt,
        "from_date": from_date,
        "to_date": to_date,
        "limit": limit,
        "account_id": params.get("accountId"),
    }, None


def _clean_row(row: dict) -> dict:
    return {col: row.get(col, "") for col in CSV_COLUMNS}


def _rows_to_csv(rows: list) -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=CSV_COLUMNS, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow(_clean_row(row))
    return buf.getvalue()


def _rows_to_json(rows: list) -> str:
    return json.dumps([_clean_row(r) for r in rows])


# ---------------------------------------------------------------------------
# HTTP Trigger: /api/stats
# ---------------------------------------------------------------------------


@app.route(route="stats", auth_level=func.AuthLevel.FUNCTION, methods=["GET"])
def stats_trigger(req: func.HttpRequest) -> func.HttpResponse:
    parsed, err = _validate_stats_params(req.params)
    if err:
        return func.HttpResponse(err, status_code=400)

    platform = parsed["platform"]
    open_id, err = _resolve_account_id(platform, parsed["account_id"])
    if err:
        return func.HttpResponse(err, status_code=400)

    try:
        if parsed["view"] == "latest":
            rows = table_storage_client.query_latest(platform, open_id)
        else:
            rows = table_storage_client.query_history(
                platform,
                open_id,
                from_date=parsed["from_date"],
                to_date=parsed["to_date"],
                limit=parsed["limit"],
            )
    except Exception as exc:
        logging.error("/api/stats error: %s", exc)
        return func.HttpResponse("Internal server error", status_code=500)

    if parsed["format"] == "csv":
        body = _rows_to_csv(rows)
        mimetype = "text/csv"
    else:
        body = _rows_to_json(rows)
        mimetype = "application/json"

    return func.HttpResponse(body, status_code=200, mimetype=mimetype)


# ---------------------------------------------------------------------------
# HTTP Trigger: /api/health
# ---------------------------------------------------------------------------


@app.route(route="health", auth_level=func.AuthLevel.ANONYMOUS, methods=["GET"])
def health_trigger(req: func.HttpRequest) -> func.HttpResponse:
    platform_param = req.params.get("platform")
    account_id_param = req.params.get("accountId")

    platforms = [platform_param] if platform_param else config.CONFIGURED_PLATFORMS

    results = []
    for plat in platforms:
        if account_id_param:
            acct = account_id_param
        else:
            try:
                acct = keyvault_client.read_token(f"{plat}-open-id")
            except Exception:
                acct = "unknown"

        row = table_storage_client.read_run_status(plat, acct)
        if row is None:
            result = {
                "platform": plat,
                "accountId": acct,
                "status": "unknown",
                "last_success_at": None,
                "last_attempt_at": None,
                "videos_last_run": None,
                "last_error": None,
            }
        else:
            result = {
                "platform": plat,
                "accountId": acct,
                "status": row.get("status", "unknown"),
                "last_success_at": row.get("last_success_at"),
                "last_attempt_at": row.get("last_attempt_at"),
                "videos_last_run": row.get("videos_last_run"),
                "last_error": row.get("last_error_message"),
            }
        results.append(result)

    body = json.dumps(results[0] if platform_param and len(results) == 1 else results)
    return func.HttpResponse(body, status_code=200, mimetype="application/json")
