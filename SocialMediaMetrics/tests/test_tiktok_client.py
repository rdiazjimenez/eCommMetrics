import pytest
import requests
from unittest.mock import MagicMock, patch, call


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_response(status_code=200, json_data=None):
    resp = MagicMock(spec=requests.Response)
    resp.status_code = status_code
    resp.json.return_value = json_data or {}
    resp.raise_for_status.return_value = None
    return resp


TOKEN_OK = {
    "access_token": "acc_new",
    "refresh_token": "ref_new",
    "open_id": "oid_123",
    "expires_in": 86400,
    "refresh_expires_in": 31536000,
}

VIDEO_PAGE_1 = {
    "data": {
        "videos": [{"id": "v1"}, {"id": "v2"}],
        "has_more": True,
        "cursor": 2,
    },
    "error": {"code": "ok", "message": ""},
}

VIDEO_PAGE_2 = {
    "data": {
        "videos": [{"id": "v3"}],
        "has_more": False,
        "cursor": 0,
    },
    "error": {"code": "ok", "message": ""},
}

VIDEO_SINGLE_PAGE = {
    "data": {
        "videos": [{"id": "v1"}, {"id": "v2"}],
        "has_more": False,
        "cursor": 0,
    },
    "error": {"code": "ok", "message": ""},
}

EMPTY_PAGE = {
    "data": {
        "videos": [],
        "has_more": False,
        "cursor": 0,
    },
    "error": {"code": "ok", "message": ""},
}


# ---------------------------------------------------------------------------
# refresh_access_token
# ---------------------------------------------------------------------------

class TestRefreshAccessToken:
    def test_happy_path_returns_token_dict(self):
        from tiktok_client import refresh_access_token
        with patch("tiktok_client.requests.post", return_value=_mock_response(json_data=TOKEN_OK)):
            result = refresh_access_token("old_refresh")
        assert result["access_token"] == "acc_new"
        assert result["refresh_token"] == "ref_new"

    def test_error_key_raises_value_error(self):
        from tiktok_client import refresh_access_token
        error_resp = {"error": "invalid_grant", "error_description": "Token expired"}
        with patch("tiktok_client.requests.post", return_value=_mock_response(json_data=error_resp)):
            with pytest.raises(ValueError, match="TikTok token refresh error"):
                refresh_access_token("bad_refresh")

    def test_429_retries_and_succeeds(self):
        from tiktok_client import refresh_access_token
        rate_limited = _mock_response(status_code=429, json_data={})
        rate_limited.raise_for_status.side_effect = requests.HTTPError("429")
        success = _mock_response(json_data=TOKEN_OK)

        with patch("tiktok_client.requests.post", side_effect=[rate_limited, success]):
            with patch("tiktok_client.time.sleep"):
                result = refresh_access_token("ref")
        assert result["access_token"] == "acc_new"

    def test_timeout_retries_and_succeeds(self):
        from tiktok_client import refresh_access_token
        success = _mock_response(json_data=TOKEN_OK)

        with patch("tiktok_client.requests.post", side_effect=[requests.Timeout, success]):
            with patch("tiktok_client.time.sleep"):
                result = refresh_access_token("ref")
        assert result["access_token"] == "acc_new"

    def test_timeout_exhausted_raises(self):
        from tiktok_client import refresh_access_token
        with patch("tiktok_client.requests.post", side_effect=requests.Timeout):
            with patch("tiktok_client.time.sleep"):
                with pytest.raises(requests.Timeout):
                    refresh_access_token("ref")


# ---------------------------------------------------------------------------
# fetch_video_list
# ---------------------------------------------------------------------------

class TestFetchVideoList:
    def test_single_page_returns_videos_and_fetch_complete_true(self):
        from tiktok_client import fetch_video_list
        with patch("tiktok_client.requests.post", return_value=_mock_response(json_data=VIDEO_SINGLE_PAGE)):
            videos, fetch_complete = fetch_video_list("acc", "oid")
        assert len(videos) == 2
        assert fetch_complete is True

    def test_two_pages_returns_combined_list_and_fetch_complete_true(self):
        from tiktok_client import fetch_video_list
        with patch(
            "tiktok_client.requests.post",
            side_effect=[
                _mock_response(json_data=VIDEO_PAGE_1),
                _mock_response(json_data=VIDEO_PAGE_2),
            ],
        ):
            videos, fetch_complete = fetch_video_list("acc", "oid")
        assert [v["id"] for v in videos] == ["v1", "v2", "v3"]
        assert fetch_complete is True

    def test_exception_mid_pagination_returns_fetch_complete_false(self):
        from tiktok_client import fetch_video_list
        with patch(
            "tiktok_client.requests.post",
            side_effect=[
                _mock_response(json_data=VIDEO_PAGE_1),
                requests.Timeout,
                requests.Timeout,
                requests.Timeout,
            ],
        ):
            with patch("tiktok_client.time.sleep"):
                videos, fetch_complete = fetch_video_list("acc", "oid")
        assert fetch_complete is False
        assert len(videos) == 2  # partial results from first page

    def test_empty_video_list_stops_loop(self):
        from tiktok_client import fetch_video_list
        with patch("tiktok_client.requests.post", return_value=_mock_response(json_data=EMPTY_PAGE)):
            videos, fetch_complete = fetch_video_list("acc", "oid")
        assert videos == []
        assert fetch_complete is True
