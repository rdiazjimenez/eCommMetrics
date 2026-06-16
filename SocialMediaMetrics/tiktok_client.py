import logging
import time

import requests

import config

TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/"
TIKTOK_VIDEO_LIST_URL = "https://open.tiktokapis.com/v2/video/list/"
TIMEOUT = 15
MAX_RETRIES = 3
VIDEO_FIELDS = (
    "id,title,video_description,create_time,duration,"
    "view_count,like_count,comment_count,share_count,share_url,cover_image_url"
)


def _post_with_retry(url: str, **kwargs) -> requests.Response:
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post(url, timeout=TIMEOUT, **kwargs)
            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt < MAX_RETRIES - 1:
                    time.sleep(2**attempt)
                    continue
                resp.raise_for_status()
            return resp
        except requests.Timeout:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2**attempt)
                continue
            raise
    raise RuntimeError(f"Max retries exceeded for {url}")  # pragma: no cover


def refresh_access_token(refresh_token: str) -> dict:
    resp = _post_with_retry(
        TIKTOK_TOKEN_URL,
        data={
            "client_key": config.TIKTOK_CLIENT_KEY,
            "client_secret": config.TIKTOK_CLIENT_SECRET,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        },
    )
    data = resp.json()
    if data.get("error"):
        raise ValueError(f"TikTok token refresh error: {data['error']}")
    return data


def fetch_video_list(access_token: str, open_id: str) -> tuple:
    videos = []
    cursor = None
    fetch_complete = False

    try:
        while True:
            payload: dict = {"max_count": 20}
            if cursor is not None:
                payload["cursor"] = cursor

            resp = _post_with_retry(
                f"{TIKTOK_VIDEO_LIST_URL}?fields={VIDEO_FIELDS}",
                headers={"Authorization": f"Bearer {access_token}"},
                json=payload,
            )

            data = resp.json()
            error = data.get("error", {})
            if isinstance(error, dict) and error.get("code", "ok") != "ok":
                raise ValueError(f"TikTok API error: {error}")

            page_data = data.get("data", {})
            page_videos = page_data.get("videos", [])
            videos.extend(page_videos)

            if not page_videos or not page_data.get("has_more", False):
                fetch_complete = True
                break

            cursor = page_data.get("cursor")

    except Exception as exc:
        logging.error("TikTok video list fetch error: %s", exc)

    return videos, fetch_complete
