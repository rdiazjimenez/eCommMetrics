import json
import pytest
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# Mock HttpRequest helper
# ---------------------------------------------------------------------------

class MockHttpRequest:
    def __init__(self, params: dict | None = None):
        self.params = params or {}
        self.method = "GET"
        self.headers = {}


SAMPLE_ROW = {
    "snapshot_date": "2026-05-25",
    "video_id": "vid1",
    "open_id": "oid_abc",
    "title": "Test Video",
    "description": "desc",
    "create_time": 1700000000,
    "duration_sec": 30,
    "view_count": 1000,
    "like_count": 50,
    "comment_count": 10,
    "share_count": 5,
    "share_url": "https://tiktok.com/v/vid1",
    "cover_url": "https://cdn.tiktok.com/cover.jpg",
    "fetched_at": "2026-05-25T08:01:23Z",
}

STATUS_ROW = {
    "PartitionKey": "tiktok",
    "RowKey": "oid_abc",
    "status": "ok",
    "last_success_at": "2026-05-25T08:01:23Z",
    "last_attempt_at": "2026-05-25T08:01:23Z",
    "videos_last_run": 42,
    "last_error_message": None,
}


def _make_req(params):
    return MockHttpRequest(params=params)


# ---------------------------------------------------------------------------
# /api/stats — validation
# ---------------------------------------------------------------------------

class TestStatsValidation:
    def _call(self, params):
        import function_app
        with patch.object(function_app, "keyvault_client") as mock_kv:
            mock_kv.read_token.return_value = "oid_abc"
            with patch.object(function_app, "table_storage_client") as mock_ts:
                mock_ts.query_latest.return_value = []
                mock_ts.query_history.return_value = []
                resp = function_app.stats_trigger(_make_req(params))
        return resp

    def test_unknown_platform_returns_400(self):
        resp = self._call({"platform": "snapchat"})
        assert resp.status_code == 400

    def test_invalid_format_returns_400(self):
        resp = self._call({"platform": "tiktok", "format": "xml"})
        assert resp.status_code == 400

    def test_invalid_view_returns_400(self):
        resp = self._call({"platform": "tiktok", "view": "bad"})
        assert resp.status_code == 400

    def test_invalid_from_date_returns_400(self):
        resp = self._call({"platform": "tiktok", "from": "not-a-date"})
        assert resp.status_code == 400

    def test_limit_zero_returns_400(self):
        resp = self._call({"platform": "tiktok", "limit": "0"})
        assert resp.status_code == 400

    def test_limit_10001_returns_400(self):
        resp = self._call({"platform": "tiktok", "limit": "10001"})
        assert resp.status_code == 400


class TestStatsSuccess:
    def test_latest_csv_returns_200_with_csv_header(self):
        import function_app
        with patch.object(function_app, "keyvault_client") as mock_kv:
            mock_kv.read_token.return_value = "oid_abc"
            with patch.object(function_app, "table_storage_client") as mock_ts:
                mock_ts.query_latest.return_value = [SAMPLE_ROW]
                resp = function_app.stats_trigger(
                    _make_req({"platform": "tiktok", "view": "latest", "format": "csv"})
                )
        assert resp.status_code == 200
        body = resp.get_body().decode()
        assert "snapshot_date" in body
        assert "video_id" in body

    def test_history_json_returns_200_with_json_array(self):
        import function_app
        with patch.object(function_app, "keyvault_client") as mock_kv:
            mock_kv.read_token.return_value = "oid_abc"
            with patch.object(function_app, "table_storage_client") as mock_ts:
                mock_ts.query_history.return_value = [SAMPLE_ROW]
                resp = function_app.stats_trigger(
                    _make_req({"platform": "tiktok", "view": "history", "format": "json"})
                )
        assert resp.status_code == 200
        data = json.loads(resp.get_body())
        assert isinstance(data, list)
        assert data[0]["video_id"] == "vid1"


# ---------------------------------------------------------------------------
# /api/health
# ---------------------------------------------------------------------------

class TestHealth:
    def test_with_status_row_returns_correct_shape(self):
        import function_app
        with patch.object(function_app, "keyvault_client") as mock_kv:
            mock_kv.read_token.return_value = "oid_abc"
            with patch.object(function_app, "table_storage_client") as mock_ts:
                mock_ts.read_run_status.return_value = STATUS_ROW
                resp = function_app.health_trigger(
                    _make_req({"platform": "tiktok"})
                )
        assert resp.status_code == 200
        data = json.loads(resp.get_body())
        assert data["status"] == "ok"
        assert data["platform"] == "tiktok"
        assert "last_success_at" in data
        assert "videos_last_run" in data

    def test_absent_status_row_returns_unknown(self):
        import function_app
        with patch.object(function_app, "keyvault_client") as mock_kv:
            mock_kv.read_token.return_value = "oid_abc"
            with patch.object(function_app, "table_storage_client") as mock_ts:
                mock_ts.read_run_status.return_value = None
                resp = function_app.health_trigger(
                    _make_req({"platform": "tiktok"})
                )
        assert resp.status_code == 200
        data = json.loads(resp.get_body())
        assert data["status"] == "unknown"

    def test_no_platform_param_returns_array(self):
        import function_app
        with patch.object(function_app, "config") as mock_cfg:
            mock_cfg.CONFIGURED_PLATFORMS = ["tiktok"]
            with patch.object(function_app, "keyvault_client") as mock_kv:
                mock_kv.read_token.return_value = "oid_abc"
                with patch.object(function_app, "table_storage_client") as mock_ts:
                    mock_ts.read_run_status.return_value = STATUS_ROW
                    resp = function_app.health_trigger(_make_req({}))
        assert resp.status_code == 200
        data = json.loads(resp.get_body())
        assert isinstance(data, list)
        assert data[0]["platform"] == "tiktok"


# ---------------------------------------------------------------------------
# Timer Trigger
# ---------------------------------------------------------------------------

class TestTimerTrigger:
    def test_one_platform_fails_others_still_run_and_error_raised(self):
        import function_app
        from exceptions import MultiPlatformRunError

        mock_tiktok = MagicMock()
        mock_tiktok.return_value.run.return_value = ("oid_tiktok", 10)
        mock_instagram = MagicMock()
        mock_instagram.return_value.run.side_effect = RuntimeError("Instagram broken")

        with patch.object(function_app, "config") as mock_cfg:
            mock_cfg.CONFIGURED_PLATFORMS = ["tiktok", "instagram"]
            with patch.object(function_app, "REGISTRY", {"tiktok": mock_tiktok, "instagram": mock_instagram}):
                with patch.object(function_app, "table_storage_client") as mock_ts:
                    mock_ts.write_run_status.return_value = None
                    with patch.object(function_app, "keyvault_client") as mock_kv:
                        mock_kv.read_token.return_value = "oid_instagram"
                        with pytest.raises(MultiPlatformRunError) as exc_info:
                            function_app.timer_trigger(MagicMock())

        assert "instagram" in exc_info.value.failed_platforms
        assert "tiktok" not in exc_info.value.failed_platforms
        # Both adapters were called
        mock_tiktok.return_value.run.assert_called_once()
        mock_instagram.return_value.run.assert_called_once()

    def test_all_platforms_succeed_no_exception(self):
        import function_app

        mock_tiktok = MagicMock()
        mock_tiktok.return_value.run.return_value = ("oid_tiktok", 5)

        with patch.object(function_app, "config") as mock_cfg:
            mock_cfg.CONFIGURED_PLATFORMS = ["tiktok"]
            with patch.object(function_app, "REGISTRY", {"tiktok": mock_tiktok}):
                with patch.object(function_app, "table_storage_client") as mock_ts:
                    mock_ts.write_run_status.return_value = None
                    with patch.object(function_app, "keyvault_client"):
                        function_app.timer_trigger(MagicMock())  # must not raise

        mock_ts.write_run_status.assert_called_once_with(
            "tiktok", "oid_tiktok", "ok", videos_count=5
        )

    def test_fetch_incomplete_marks_run_failed(self):
        import function_app
        from exceptions import MultiPlatformRunError

        mock_tiktok = MagicMock()
        mock_tiktok.return_value.run.side_effect = RuntimeError("TikTok fetch incomplete")

        with patch.object(function_app, "config") as mock_cfg:
            mock_cfg.CONFIGURED_PLATFORMS = ["tiktok"]
            with patch.object(function_app, "REGISTRY", {"tiktok": mock_tiktok}):
                with patch.object(function_app, "table_storage_client") as mock_ts:
                    mock_ts.write_run_status.return_value = None
                    with patch.object(function_app, "keyvault_client") as mock_kv:
                        mock_kv.read_token.return_value = "oid_tiktok"
                        with pytest.raises(MultiPlatformRunError):
                            function_app.timer_trigger(MagicMock())

        write_calls = mock_ts.write_run_status.call_args_list
        assert any(c[0][2] == "error" for c in write_calls)
