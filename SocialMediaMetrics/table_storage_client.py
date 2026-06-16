import logging
from datetime import datetime, timezone

from azure.core.exceptions import ResourceNotFoundError
from azure.data.tables import TableServiceClient, UpdateMode

import config

_service: TableServiceClient | None = None


def _get_service() -> TableServiceClient:
    global _service
    if _service is None:
        _service = TableServiceClient.from_connection_string(config.STORAGE_CONNECTION_STRING)
    return _service


def _table(name: str):
    return _get_service().get_table_client(name)


def upsert_video_snapshot(video: dict, snapshot_date: str, open_id: str) -> None:
    video_id = video["id"]
    fetched_at = datetime.now(timezone.utc).isoformat()

    props = {
        "snapshot_date": snapshot_date,
        "video_id": video_id,
        "open_id": open_id,
        "title": video.get("title", ""),
        "description": video.get("video_description", ""),
        "create_time": video.get("create_time", 0),
        "duration_sec": video.get("duration", 0),
        "view_count": video.get("view_count", 0),
        "like_count": video.get("like_count", 0),
        "comment_count": video.get("comment_count", 0),
        "share_count": video.get("share_count", 0),
        "share_url": video.get("share_url", ""),
        "cover_url": video.get("cover_image_url", ""),
        "fetched_at": fetched_at,
    }

    snapshot_entity = {
        "PartitionKey": snapshot_date,
        "RowKey": f"{open_id}_{video_id}",
        **props,
    }
    _table("tiktoksnapshots").upsert_entity(snapshot_entity)

    latest_entity = {
        "PartitionKey": open_id,
        "RowKey": video_id,
        **props,
    }
    _table("tiktoklatest").upsert_entity(latest_entity)


def run_deletion_diff(open_id: str, current_video_ids: set, fetch_complete: bool) -> None:
    if not fetch_complete:
        return

    tc = _table("tiktoklatest")
    existing = tc.query_entities(
        query_filter=f"PartitionKey eq '{open_id}'",
        select=["RowKey"],
    )
    existing_ids = {e["RowKey"] for e in existing}

    for video_id in existing_ids - current_video_ids:
        tc.delete_entity(partition_key=open_id, row_key=video_id)


def write_run_status(
    platform: str,
    account_id: str,
    status: str,
    videos_count: int = 0,
    error_message: str = "",
) -> None:
    try:
        now = datetime.now(timezone.utc).isoformat()
        entity: dict = {
            "PartitionKey": platform,
            "RowKey": account_id,
            "status": status,
            "last_attempt_at": now,
        }
        if status == "ok":
            entity["last_success_at"] = now
            entity["videos_last_run"] = videos_count
        else:
            entity["last_error_at"] = now
            entity["last_error_message"] = error_message

        _table("pipelinerunstatus").upsert_entity(entity, mode=UpdateMode.MERGE)
    except Exception as exc:
        logging.warning("Failed to write run status for %s/%s: %s", platform, account_id, exc)


def query_latest(platform: str, open_id: str) -> list:
    table_name = f"{platform}latest"
    return list(_table(table_name).query_entities(f"PartitionKey eq '{open_id}'"))


def query_history(
    platform: str,
    open_id: str,
    from_date: str | None = None,
    to_date: str | None = None,
    limit: int | None = None,
) -> list:
    table_name = f"{platform}snapshots"
    filters = []
    if from_date:
        filters.append(f"PartitionKey ge '{from_date}'")
    if to_date:
        filters.append(f"PartitionKey le '{to_date}'")

    filter_str = " and ".join(filters) if filters else None
    tc = _table(table_name)
    results = tc.query_entities(query_filter=filter_str) if filter_str else tc.list_entities()

    items = list(results)
    if limit is not None:
        items = items[:limit]
    return items


def read_run_status(platform: str, account_id: str) -> dict | None:
    try:
        return _table("pipelinerunstatus").get_entity(
            partition_key=platform, row_key=account_id
        )
    except ResourceNotFoundError:
        return None
