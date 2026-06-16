import pytest
from unittest.mock import MagicMock, patch, call
from azure.core.exceptions import ResourceNotFoundError


SAMPLE_VIDEO = {
    "id": "vid123",
    "title": "My Video",
    "video_description": "A description",
    "create_time": 1700000000,
    "duration": 30,
    "view_count": 1000,
    "like_count": 50,
    "comment_count": 10,
    "share_count": 5,
    "share_url": "https://tiktok.com/v/vid123",
    "cover_image_url": "https://cdn.tiktok.com/cover.jpg",
}
OPEN_ID = "oid_abc"
SNAPSHOT_DATE = "2026-05-25"


def _make_mock_service():
    mock_service = MagicMock()
    mock_table = MagicMock()
    mock_service.get_table_client.return_value = mock_table
    return mock_service, mock_table


# ---------------------------------------------------------------------------
# upsert_video_snapshot
# ---------------------------------------------------------------------------

class TestUpsertVideoSnapshot:
    def test_snapshot_entity_keys(self):
        import table_storage_client
        mock_service = MagicMock()
        snapshots_table = MagicMock()
        latest_table = MagicMock()

        def get_table(name):
            if name == "tiktoksnapshots":
                return snapshots_table
            if name == "tiktoklatest":
                return latest_table
            return MagicMock()

        mock_service.get_table_client.side_effect = get_table

        with patch.object(table_storage_client, "_get_service", return_value=mock_service):
            table_storage_client.upsert_video_snapshot(SAMPLE_VIDEO, SNAPSHOT_DATE, OPEN_ID)

        snap_call = snapshots_table.upsert_entity.call_args[0][0]
        assert snap_call["PartitionKey"] == SNAPSHOT_DATE
        assert snap_call["RowKey"] == f"{OPEN_ID}#vid123"

    def test_latest_entity_keys(self):
        import table_storage_client
        mock_service = MagicMock()
        snapshots_table = MagicMock()
        latest_table = MagicMock()

        def get_table(name):
            if name == "tiktoksnapshots":
                return snapshots_table
            if name == "tiktoklatest":
                return latest_table
            return MagicMock()

        mock_service.get_table_client.side_effect = get_table

        with patch.object(table_storage_client, "_get_service", return_value=mock_service):
            table_storage_client.upsert_video_snapshot(SAMPLE_VIDEO, SNAPSHOT_DATE, OPEN_ID)

        latest_call = latest_table.upsert_entity.call_args[0][0]
        assert latest_call["PartitionKey"] == OPEN_ID
        assert latest_call["RowKey"] == "vid123"

    def test_both_entities_contain_all_14_properties(self):
        import table_storage_client
        mock_service = MagicMock()
        snapshots_table = MagicMock()
        latest_table = MagicMock()

        def get_table(name):
            if name == "tiktoksnapshots":
                return snapshots_table
            return latest_table

        mock_service.get_table_client.side_effect = get_table

        with patch.object(table_storage_client, "_get_service", return_value=mock_service):
            table_storage_client.upsert_video_snapshot(SAMPLE_VIDEO, SNAPSHOT_DATE, OPEN_ID)

        REQUIRED = {
            "snapshot_date", "video_id", "open_id", "title", "description",
            "create_time", "duration_sec", "view_count", "like_count",
            "comment_count", "share_count", "share_url", "cover_url", "fetched_at",
        }

        snap_entity = snapshots_table.upsert_entity.call_args[0][0]
        latest_entity = latest_table.upsert_entity.call_args[0][0]
        assert REQUIRED.issubset(snap_entity.keys())
        assert REQUIRED.issubset(latest_entity.keys())


# ---------------------------------------------------------------------------
# run_deletion_diff
# ---------------------------------------------------------------------------

class TestRunDeletionDiff:
    def test_absent_rows_deleted(self):
        import table_storage_client
        mock_service = MagicMock()
        latest_table = MagicMock()
        mock_service.get_table_client.return_value = latest_table
        latest_table.query_entities.return_value = [
            {"RowKey": "vid1"},
            {"RowKey": "vid2"},
            {"RowKey": "vid3"},
        ]

        with patch.object(table_storage_client, "_get_service", return_value=mock_service):
            table_storage_client.run_deletion_diff(OPEN_ID, {"vid1", "vid2"}, fetch_complete=True)

        latest_table.delete_entity.assert_called_once_with(
            partition_key=OPEN_ID, row_key="vid3"
        )

    def test_deletion_skipped_when_fetch_incomplete(self):
        import table_storage_client
        mock_service = MagicMock()
        latest_table = MagicMock()
        mock_service.get_table_client.return_value = latest_table

        with patch.object(table_storage_client, "_get_service", return_value=mock_service):
            table_storage_client.run_deletion_diff(OPEN_ID, {"vid1"}, fetch_complete=False)

        latest_table.query_entities.assert_not_called()
        latest_table.delete_entity.assert_not_called()


# ---------------------------------------------------------------------------
# write_run_status
# ---------------------------------------------------------------------------

class TestWriteRunStatus:
    def _run(self, status, **kwargs):
        import table_storage_client
        mock_service = MagicMock()
        status_table = MagicMock()
        mock_service.get_table_client.return_value = status_table

        with patch.object(table_storage_client, "_get_service", return_value=mock_service):
            table_storage_client.write_run_status("tiktok", OPEN_ID, status, **kwargs)

        return status_table.upsert_entity.call_args[0][0]

    def test_success_includes_last_success_at_and_videos_last_run(self):
        entity = self._run("ok", videos_count=42)
        assert "last_success_at" in entity
        assert entity["videos_last_run"] == 42
        assert entity["status"] == "ok"

    def test_failure_includes_last_error_message(self):
        entity = self._run("error", error_message="Something broke")
        assert entity["last_error_message"] == "Something broke"
        assert "last_error_at" in entity

    def test_failure_does_not_include_last_success_at(self):
        entity = self._run("error", error_message="boom")
        assert "last_success_at" not in entity

    def test_table_write_error_is_swallowed(self):
        import table_storage_client
        mock_service = MagicMock()
        status_table = MagicMock()
        status_table.upsert_entity.side_effect = Exception("Storage unavailable")
        mock_service.get_table_client.return_value = status_table

        with patch.object(table_storage_client, "_get_service", return_value=mock_service):
            # Must not raise
            table_storage_client.write_run_status("tiktok", OPEN_ID, "ok", videos_count=0)


# ---------------------------------------------------------------------------
# query_latest
# ---------------------------------------------------------------------------

class TestQueryLatest:
    def test_uses_partition_key_filter(self):
        import table_storage_client
        mock_service = MagicMock()
        latest_table = MagicMock()
        latest_table.query_entities.return_value = []
        mock_service.get_table_client.return_value = latest_table

        with patch.object(table_storage_client, "_get_service", return_value=mock_service):
            table_storage_client.query_latest("tiktok", OPEN_ID)

        filter_arg = latest_table.query_entities.call_args[0][0]
        assert filter_arg == f"PartitionKey eq '{OPEN_ID}'"


# ---------------------------------------------------------------------------
# query_history
# ---------------------------------------------------------------------------

class TestQueryHistory:
    def _call(self, from_date=None, to_date=None, limit=None):
        import table_storage_client
        mock_service = MagicMock()
        snap_table = MagicMock()
        snap_table.query_entities.return_value = []
        snap_table.list_entities.return_value = []
        mock_service.get_table_client.return_value = snap_table

        with patch.object(table_storage_client, "_get_service", return_value=mock_service):
            table_storage_client.query_history(
                "tiktok", OPEN_ID,
                from_date=from_date,
                to_date=to_date,
                limit=limit,
            )
        return snap_table

    def test_date_range_uses_ge_and_le_clauses(self):
        snap_table = self._call(from_date="2026-01-01", to_date="2026-05-25")
        filter_arg = snap_table.query_entities.call_args[1].get(
            "query_filter"
        ) or snap_table.query_entities.call_args[0][0] if snap_table.query_entities.called else ""
        assert "ge" in filter_arg
        assert "le" in filter_arg

    def test_no_dates_uses_no_date_filter(self):
        snap_table = self._call()
        # When both are None, list_entities is called instead of query_entities
        snap_table.list_entities.assert_called_once()
        snap_table.query_entities.assert_not_called()


# ---------------------------------------------------------------------------
# read_run_status
# ---------------------------------------------------------------------------

class TestReadRunStatus:
    def test_returns_none_when_entity_absent(self):
        import table_storage_client
        mock_service = MagicMock()
        status_table = MagicMock()
        status_table.get_entity.side_effect = ResourceNotFoundError("not found")
        mock_service.get_table_client.return_value = status_table

        with patch.object(table_storage_client, "_get_service", return_value=mock_service):
            result = table_storage_client.read_run_status("tiktok", OPEN_ID)

        assert result is None

    def test_returns_entity_when_present(self):
        import table_storage_client
        mock_service = MagicMock()
        status_table = MagicMock()
        entity = {"PartitionKey": "tiktok", "RowKey": OPEN_ID, "status": "ok"}
        status_table.get_entity.return_value = entity
        mock_service.get_table_client.return_value = status_table

        with patch.object(table_storage_client, "_get_service", return_value=mock_service):
            result = table_storage_client.read_run_status("tiktok", OPEN_ID)

        assert result["status"] == "ok"
