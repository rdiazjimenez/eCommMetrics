# PRD: ECommMetrics Stats Pipeline — TikTok (Phase 1)

**Status:** Deployed — Phase 1 live as of 2026-05-26  
**Date:** 2026-05-25  
**ADRs:** 0001, 0002, 0003, 0004  
**Changelog:** `docs/CHANGELOG.md`

---

## Problem Statement

As a TikTok content creator, I want to automatically pull daily video statistics from my TikTok account into Excel — without manually renewing tokens or copying data. The current approach (Power Query connecting directly to TikTok) breaks every 24 hours because TikTok access tokens expire and renewal requires browser-based interaction. This makes any Excel-based analytics workflow unmaintainable.

---

## Solution

Build a cloud-native stats pipeline that separates storage from consumption.

- An Azure Function (Timer Trigger) runs daily, rotates TikTok OAuth tokens, fetches all video statistics via the TikTok Content Creator API v2, and persists Snapshots to Azure Table Storage.
- A second Azure Function (HTTP Trigger) exposes stored data as a CSV or JSON endpoint.
- Excel connects to that HTTP endpoint via Power Query and refreshes on demand.

Excel becomes a pure consumer. Cloud storage is the source of truth. No manual token renewal after initial setup.

This is Phase 1 of a multi-platform pipeline. The architecture supports adding Instagram, YouTube, Meta Ads, and Pinterest as subsequent platforms. See domain glossary in `CONTEXT.md`.

---

## User Stories

1. As a content creator, I want TikTok video stats fetched automatically every day, so that I never have to manually trigger a data pull.
2. As a content creator, I want the pipeline to run without me renewing OAuth tokens manually, so that the process is truly hands-off after initial setup.
3. As a content creator, I want my video stats stored in the cloud, so that historical Snapshots accumulate over time and are not lost when I close Excel.
4. As a content creator, I want to open Excel and click Refresh to see the latest stats, so that I can analyze data without leaving Excel.
5. As a content creator, I want Excel to show only the latest values per video by default, so that the workbook loads fast and does not grow unbounded.
6. As a content creator, I want to query historical Snapshots by date range, so that I can analyze trends and compute Deltas over time.
7. As a content creator, I want to see stats for all my current videos in a single table, so that I can sort and filter without switching views.
8. As a content creator, I want videos I have deleted or made private on TikTok to disappear from my current stats view, so that my data reflects my actual live video catalog.
9. As a content creator, I want deleted videos to remain in my historical Snapshots, so that I do not lose performance history for content I have removed.
10. As a content creator, I want the pipeline to log how many videos were processed each run, so that I can confirm the fetch was complete.
11. As a content creator, I want a health endpoint I can monitor externally, so that I know whether the daily job ran successfully without opening Azure Portal.
12. As a content creator, I want to receive an alert if the daily job fails or does not run for 48 hours, so that I can investigate before data gaps accumulate.
13. As a content creator, I want duplicate-free data, so that running the timer twice on the same day does not create duplicate rows.
14. As a content creator, I want the pipeline to retry failed TikTok API calls automatically, so that transient errors do not require manual re-runs.
15. As a content creator, I want the system to handle TikTok token rotation safely, so that the refresh token is never lost even if the function crashes partway through.
16. As a content creator, I want data accessible as both CSV and JSON, so that I can integrate it with other tools beyond Excel if needed.
17. As a content creator, I want total Azure cost below $1/month, so that infrastructure cost is negligible.
18. As a content creator, I want all secrets stored in Azure Key Vault, so that credentials are not exposed in code, config files, or environment variables.
19. As a content creator, I want the Excel connection URL to use a Function Key, so that the endpoint is not publicly accessible without credentials.
20. As a content creator, I want clear documentation on how to run the one-time OAuth setup, so that I can authorize my TikTok account without developer help.
21. As a content creator, I want stats to include view count, like count, comment count, share count, duration, title, and publish date per video.
22. As a content creator, I want each row to include a snapshot date, so that I can compute Deltas between two dates.
23. As a content creator, I want the system designed so additional platforms (Instagram, YouTube, Meta Ads, Pinterest) can be added without restructuring the pipeline.
24. As a content creator, I want local development to work with the same code as production, so that I can test changes without deploying to Azure.

---

## Implementation Decisions

### Architecture

"Cloud stores, Excel consumes." Two independently testable halves:

1. **Ingestion path** (Timer Trigger): Key Vault -> TikTok OAuth -> TikTok API -> Table Storage
2. **Serving path** (HTTP Trigger): Table Storage -> `/api/stats` -> Power Query -> Excel

The Timer Trigger iterates over all configured platforms. Phase 1 configures TikTok only. Adding a platform later means adding its credentials to Key Vault and its name to the platform list.

### Table Storage Schema

Three tables for Phase 1. See ADR 0001.

**`tiktoksnapshots`** — immutable historical Snapshots, one row per (date, video).
- PartitionKey: `snapshot_date` (YYYY-MM-DD)
- RowKey: `open_id_video_id` (underscore separator — `#` is forbidden in Table Storage keys)
- Properties: `snapshot_date`, `video_id`, `open_id`, `title`, `description`, `create_time` (int unix), `duration_sec` (int), `view_count`, `like_count`, `comment_count`, `share_count`, `share_url`, `cover_url`, `fetched_at` (ISO 8601 UTC)
- Rows are never deleted. Immutable historical record.

**`tiktoklatest`** — one row per currently API-visible video.
- PartitionKey: `open_id`
- RowKey: `video_id`
- Same 14 properties as `tiktoksnapshots`
- Rows are deleted when a video disappears from the TikTok API, **only after a FetchComplete run** (see ADR 0003). A partial fetch must not trigger deletions.

**`pipelinerunstatus`** — shared across all platforms, one row per (platform, AccountId).
- PartitionKey: `platform` (e.g. `"tiktok"`)
- RowKey: `AccountId` (platform-native value: TikTok `open_id`)
- Properties: `last_attempt_at`, `last_success_at`, `last_error_at`, `last_error_message`, `status` (`ok` | `error` | `unknown`)
- Run metadata is stored here, not in Key Vault.

When Instagram is added: `instagramsnapshots`, `instagramlatest`, and a new row in `pipelinerunstatus` with `PartitionKey="instagram"`.

### Key Vault Secrets

```
tiktok-refresh-token
tiktok-access-token
tiktok-open-id
```

Key Vault stores only secrets. No run metadata, no configuration.

### Token Rotation Protocol

TikTok invalidates the previous refresh token on each use. Required execution order in the timer:

1. Read `tiktok-refresh-token` from Key Vault
2. Call TikTok token refresh endpoint
3. Write new `tiktok-refresh-token` to Key Vault — **abort if this write fails**
4. Write new `tiktok-access-token` to Key Vault
5. Only then call `video/list`

If step 3 fails, raise immediately. The old token may already be invalidated; pipeline requires manual re-authorization via `setup/one_time_oauth.py`.

### FetchComplete and Deletion Safety

`FetchComplete` is a boolean flag, `False` by default. Set to `True` only when the pagination loop exits normally: all pages returned successfully and the final page had `has_more = false`. Any exception, timeout, auth failure, or rate-limit exhaustion leaves it `False`.

Deletion diff runs only when `FetchComplete is True`:

```
fetch_complete = False
try:
    paginate until has_more == False
    fetch_complete = True
except:
    mark run failed, skip deletion

if fetch_complete:
    existing_ids = query tiktoklatest for this open_id
    current_ids  = set of video_ids from this fetch
    for id in existing_ids - current_ids:
        delete from tiktoklatest
```

### Multi-Platform Timer Execution

See ADR 0004. Each platform is isolated:

```
failures = []
for platform in configured_platforms:
    try:
        run platform fetch (token rotation -> video fetch -> upsert -> deletion diff)
        write pipelinerunstatus(platform, accountId, status=ok)
    except Exception as error:
        write pipelinerunstatus(platform, accountId, status=error, error_msg)
        failures.append(platform)
        continue

if failures:
    raise MultiPlatformRunError(failed_platforms=failures)
```

One platform failure does not abort others. Re-raise after all platforms have run if any failed, so Azure marks the execution as failed.

### HTTP Endpoints

See ADR 0002. Two cross-platform endpoints:

**`GET /api/stats`**
- Auth: Azure Function Key (`?code=KEY` or `x-functions-key` header)
- Required param: `platform` (e.g. `tiktok`). Unknown platform -> HTTP 400.
- Optional param: `accountId`. If omitted and only one account is configured for that platform, resolved from Key Vault. If omitted and multiple accounts exist with no default -> HTTP 400.
- Params: `view` (latest|history, default latest), `format` (csv|json, default csv), `from` (YYYY-MM-DD), `to` (YYYY-MM-DD), `limit` (1-10000)
- `from`/`to` ignored when `view=latest`
- Invalid params -> HTTP 400 with plain-text message naming the bad parameter
- Internal errors -> HTTP 500, logged to Application Insights

CSV column order:
```
snapshot_date, video_id, open_id, title, description, create_time,
duration_sec, view_count, like_count, comment_count, share_count,
share_url, cover_url, fetched_at
```

Excel default URL:
```
https://<function_app_name>.azurewebsites.net/api/stats?platform=tiktok&view=latest&format=csv&code=FUNCTION_KEY
```

Historical example:
```
https://<function_app_name>.azurewebsites.net/api/stats?platform=tiktok&view=history&from=2026-01-01&to=2026-05-25&format=csv&code=FUNCTION_KEY
```

**`GET /api/health`**
- Auth: ANONYMOUS (for external uptime monitoring). Change to FUNCTION if privacy is required.
- Optional params: `platform`, `accountId`. If omitted, returns status for all configured platforms.
- Reads from `pipelinerunstatus`.
- Returns `status=unknown` if no row exists yet for that platform/account.

Response shape:
```json
{
  "platform": "tiktok",
  "accountId": "...",
  "status": "ok | error | unknown",
  "last_success_at": "2026-05-25T08:01:23Z",
  "last_attempt_at": "2026-05-25T08:01:23Z",
  "videos_last_run": 42,
  "last_error": null
}
```

Multi-platform response (no platform param) returns an array of the above.

### AccountId Resolution

At the HTTP layer, platform-native IDs (`open_id`, `channel_id`) are never exposed. All external surfaces use `accountId`.

Resolution rule:
- `accountId` provided -> use directly
- `accountId` omitted, one account configured -> resolve from Key Vault, use internally
- `accountId` omitted, multiple accounts, no default -> HTTP 400

### Timer Schedule

One shared `TIMER_SCHEDULE` App Setting for all platforms. Default: `0 0 8 * * *` (daily 08:00 UTC). Timer decorator uses `schedule="%TIMER_SCHEDULE%"`.

### Security

Default (personal, private workbook): Azure Function Key embedded in Power Query URL.

If workbook is shared: enable Easy Auth on the Function App (Azure Portal > Authentication > Add provider > Microsoft). Power Query authenticates with signed-in Microsoft account. No key in the file. See ADR if this upgrade is made.

### Modules

**`config`** — reads all configuration from env vars at import time. No defaults for required secrets.

**`keyvault_client`** — cached `SecretClient`, exposes `read_token` / `write_token`. Used only for secrets.

**`tiktok_client`** — token refresh + paginated `video/list` fetch. Owns `FetchComplete` flag. Retry/backoff for 429 and 5xx. 15s timeout. Returns `(videos: list, fetch_complete: bool)`.

**`table_storage_client`** — upsert to `tiktoksnapshots` and `tiktoklatest`, deletion diff for `tiktoklatest`, upsert to `pipelinerunstatus`, query methods for `/api/stats` and `/api/health`.

**`platform_registry`** — maps platform name to its fetch adapter. Phase 1 has one entry: `"tiktok" -> TikTokAdapter`. Adding Instagram adds one entry.

**`function_app`** — Timer Trigger (multi-platform loop with isolation) + HTTP Trigger (`/api/stats`) + HTTP Trigger (`/api/health`).

**`setup/one_time_oauth`** — standalone, not deployed. Browser OAuth flow for TikTok, writes three secrets to Key Vault.

**`setup/create_tables`** — standalone, not deployed. Creates `tiktoksnapshots`, `tiktoklatest`, `pipelinerunstatus`. Idempotent.

### Cost

| Service | Monthly cost |
|---|---|
| Azure Functions Consumption Plan | $0.00 |
| Azure Storage Account (LRS) | ~$0.05 |
| Azure Key Vault Standard | ~$0.001 |
| Application Insights (5 GB free) | $0.00 |
| **Total** | **~$0.05** |

---

## Testing Decisions

Tests verify observable behavior at module boundaries, not internal implementation. External calls (TikTok API, Key Vault, Table Storage) are mocked at the I/O boundary.

**`tiktok_client`**
- `refresh_access_token`: happy path returns correct dict; `error` key in response raises `ValueError`; HTTP 429 retries and succeeds on second attempt; `Timeout` retries
- `fetch_video_list`: single page (`has_more=False`) returns list and `fetch_complete=True`; two pages returns combined list and `fetch_complete=True`; exception mid-pagination returns `fetch_complete=False`; empty video list stops loop

**`table_storage_client`**
- `upsert_video_snapshot`: history entity has `PartitionKey=snapshot_date`, `RowKey=open_id_video_id`; latest entity has `PartitionKey=open_id`, `RowKey=video_id`; both contain all 14 named properties
- Deletion diff: rows absent from current fetch are deleted from `tiktoklatest`; deletion does not run when `fetch_complete=False`
- `write_run_status` success path: entity includes `last_success_at` and `videos_last_run`
- `write_run_status` failure path: entity includes `last_error_message`; does not update `last_success_at`
- `write_run_status` swallows table write errors without raising
- `query_latest`: OData filter is `PartitionKey eq '{open_id}'`
- `query_history`: filter includes `ge`/`le` clauses when both dates provided; no filter when both are None
- `read_run_status`: returns `None` when entity absent

**`function_app` HTTP triggers**
- `/api/stats?platform=tiktok&view=latest&format=csv` returns 200 with correct CSV header row
- `/api/stats?platform=tiktok&view=history&format=json` returns 200 with JSON array
- Unknown `platform` -> 400; `format=xml` -> 400; `view=bad` -> 400; `from=not-a-date` -> 400; `limit=0` -> 400; `limit=10001` -> 400
- `/api/health` with status row returns correct JSON shape; status row absent returns `status=unknown`
- `/api/health` without platform param returns array of all platform statuses

**`function_app` Timer Trigger**
- One platform fails: other platforms still run; `MultiPlatformRunError` is raised after all platforms complete
- All platforms succeed: no exception raised; `pipelinerunstatus` updated for each
- `FetchComplete=False`: deletion diff skipped; run marked failed

---

## Out of Scope

- Shopify: connects directly from Excel via native connector. Not part of this pipeline.
- Instagram, YouTube, Meta Ads, Pinterest ingestion (Phase 2+)
- Delta / incremental stats materialization (derived from Snapshots, not stored)
- TikTok production app review (sandbox sufficient for personal single-account use)
- Dashboard or web UI
- Automated infrastructure provisioning (Terraform, Bicep)
- CI/CD pipeline for the Function App
- Easy Auth / Entra ID (documented upgrade path, not built now)
- Push notifications or webhooks on new data

---

## Further Notes

**Snapshot semantics:** TikTok returns cumulative lifetime totals, not daily increments. A row with `snapshot_date=2026-05-25, view_count=12500` means "as of 2026-05-25, this video had 12,500 total lifetime views." Daily earned views must be computed as a Delta between two Snapshots.

**Why two tables (`tiktoksnapshots` + `tiktoklatest`):** Without `tiktoklatest`, Excel loads the full historical dataset on every refresh. After one year of daily runs, that is 36,000+ rows. `tiktoklatest` keeps the default Excel view to N rows (one per current video). Historical analysis is an explicit opt-in via `view=history`.

**Why `pipelinerunstatus` not Key Vault for run metadata:** Key Vault is not writable at runtime without the management-plane API. Run metadata must be writable by the function's managed identity. Table Storage is the right tool. Key Vault is for secrets only.

**Why per-platform tables:** Platforms have incompatible ContentItem schemas. TikTok Videos have `view_count, like_count, share_count`. Pinterest Pins have `save_count, click_count`. A unified table requires nullable columns or key-value blobs. Per-platform tables each own their schema cleanly. See ADR 0001.

**Why single `/api/stats` endpoint:** Excel Power Query URLs are baked into workbooks. Adding Instagram means changing `platform=tiktok` to `platform=instagram`, nothing else. Per-platform routes would require workbook changes on every new platform. See ADR 0002.
