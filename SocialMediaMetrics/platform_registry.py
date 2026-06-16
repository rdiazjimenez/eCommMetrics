from datetime import datetime, timezone

import keyvault_client
import table_storage_client
from tiktok_client import fetch_video_list, refresh_access_token


class TikTokAdapter:
    PLATFORM = "tiktok"

    def run(self) -> tuple:
        # Token rotation — order is critical: write refresh token before any API call.
        refresh_token = keyvault_client.read_token("tiktok-refresh-token")
        token_data = refresh_access_token(refresh_token)

        # Abort immediately if refresh token write fails — old token may be consumed.
        keyvault_client.write_token("tiktok-refresh-token", token_data["refresh_token"])
        keyvault_client.write_token("tiktok-access-token", token_data["access_token"])

        open_id = keyvault_client.read_token("tiktok-open-id")

        videos, fetch_complete = fetch_video_list(token_data["access_token"], open_id)

        snapshot_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        for video in videos:
            table_storage_client.upsert_video_snapshot(video, snapshot_date, open_id)

        current_ids = {v["id"] for v in videos}
        table_storage_client.run_deletion_diff(open_id, current_ids, fetch_complete)

        if not fetch_complete:
            raise RuntimeError("TikTok fetch incomplete — pagination failed or API error")

        return open_id, len(videos)


REGISTRY: dict[str, type] = {
    "tiktok": TikTokAdapter,
}
