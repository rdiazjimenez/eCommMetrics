# PRD: ECommMetrics Stats Pipeline — Instagram + Meta Ads (Phase 2)

**Status:** Ready for implementation  
**Date:** 2026-05-26  
**Depends on:** Phase 1 deployed (`docs/prd-tiktok-stats-pipeline.md`)  
**ADRs:** 0001, 0002, 0003, 0004 (all inherited from Phase 1)

---

## Problem Statement

Phase 1 delivers TikTok stats automatically. The same creator operates an Instagram Business account and runs Meta Ads campaigns. Stats for both are currently pulled manually. The goals are identical to Phase 1: daily automated fetch, no manual token renewal, historical snapshots, Excel via Power Query.

Instagram and Meta Ads share the same Facebook token but have different data shapes, different fetch logic, and different deletion semantics. They are implemented as two separate platforms (`instagram`, `metaads`) sharing one token in Key Vault.

---

## Scope

| Platform | Content | Stats |
|---|---|---|
| `instagram` | Posts, Reels, Stories | Metrics by media type: reach, impressions, likes, comments, shares, saves, plays (video/reels), replies (stories) |
| `metaads` | Ads (ad level + campaign level) | spend, impressions, clicks, reach, CPM, CPC, CTR, purchases, ROAS, currency |

---

## User Stories

1. As a content creator, I want Instagram post and Reel stats fetched daily, so that I can track organic content performance in Excel without manual work.
2. As a content creator, I want Instagram Story stats captured while stories are still active, so that ephemeral content performance is not lost.
3. As a content creator, I want reach and impressions per post alongside engagement, so that I can distinguish content that spreads from content that just gets likes.
4. As a content creator, I want Meta Ads spend and ROAS at both ad and campaign level, so that I can see which creative drives results without leaving Excel.
5. As a content creator, I want the Facebook token renewed automatically at each daily run, so that the 60-day long-lived token never expires unnoticed.
6. As a content creator, I want the Instagram and Meta Ads pipelines to fail independently, so that an Ads API outage does not block organic post stats.
7. As a content creator, I want posts I delete or archive on Instagram to disappear from the latest view, so that my current stats reflect only live content.
8. As a content creator, I want deleted posts to remain in historical snapshots, so that performance history is not lost.
9. As a content creator, I want the same `/api/stats` and `/api/health` endpoints, so that I only change `platform=instagram` or `platform=metaads` in Power Query.

---

## Implementation Decisions

### Platform Names

```
instagram   — organic content (posts, reels, stories)
metaads     — paid advertising (ad level + campaign level)
```

Add both to `CONFIGURED_PLATFORMS` App Setting:
```
CONFIGURED_PLATFORMS=tiktok,instagram,metaads
```

### Facebook Token Strategy

Instagram Business and Meta Ads share one Facebook User Access Token. One token in Key Vault covers both platforms. Both adapters access it through `MetaTokenProvider` — a module with in-process per-run caching.

**`MetaTokenProvider` design:**
- Module-level cache: `_cached_token: str | None = None`
- `get_fresh_token() -> str`:
  1. If `_cached_token` is set, return it immediately (already refreshed this run)
  2. Read `meta-access-token` from Key Vault
  3. Call Meta token refresh endpoint → get new long-lived token
  4. Write new token to Key Vault (`meta-access-token`) — if write fails, raise immediately
  5. Set `_cached_token = new_token`, return it
- `reset()` — clears cache (called in tests only)

**Both `InstagramAdapter` and `MetaAdsAdapter` call `MetaTokenProvider.get_fresh_token()` independently.** No order dependency. ADR 0004 isolation is preserved:
- If `instagram` runs first and token refresh succeeds: `_cached_token` is set; `metaads` gets the cached token with no additional KV call.
- If token refresh fails: the calling adapter raises, that platform is marked failed; the other adapter calls `get_fresh_token()` again and may also fail — but each failure is recorded independently in `pipelinerunstatus`.
- Token is NOT immediately invalidated by Meta (unlike TikTok) — old token remains valid briefly, so a write failure does not lose access.

**`timer_trigger()` MUST call `MetaTokenProvider.reset()` at the start of every invocation, before the platform loop.** Do not rely on cold starts — Azure Functions Consumption plan may keep the process warm between daily runs, causing `_cached_token` to persist across days and skip the refresh.

```python
def timer_trigger(timer: func.TimerRequest) -> None:
    MetaTokenProvider.reset()   # ← always first, before platform loop
    for platform_name in config.CONFIGURED_PLATFORMS:
        ...
```

**Long-lived token lifecycle:**
- Issued with 60-day expiry
- Refreshed at every daily run by calling the `fb_exchange_token` grant
- Cache is reset explicitly at timer start — do not rely on cold starts

**Token age tracking (health warning):**

After a successful token refresh, write the refresh timestamp to Key Vault:
```
meta-token-last-refreshed-at   — ISO 8601 UTC string, e.g. "2026-05-26T08:01:00Z"
```

`/api/health` for `instagram` or `metaads` must include `token_age_days` derived from this value. If `token_age_days >= 45`, include `"token_warning": "Meta token approaching expiry — re-run setup/one_time_oauth_meta.py before day 60"` in the health response.

**Manual re-authorization is still required if:** (a) the token expires before being refreshed (function was stopped for > 60 days), or (b) the Facebook App permissions change. When this happens, re-run `setup/one_time_oauth_meta.py`. The pipeline does NOT promise perpetual no-touch token renewal — it prevents expiry under normal daily-run conditions only.

### Key Vault Secrets

```
meta-access-token        — long-lived Facebook User Access Token (shared by instagram + metaads)
instagram-account-id     — Instagram Business account ID (numeric string)
meta-ads-account-id      — Ad account ID (format: act_XXXXXXXXX)
meta-page-id             — Facebook Page ID linked to the Instagram account
```

### AccountId Secret Names

The generic `{platform}-open-id` key name used for TikTok does not apply to Instagram/Meta. Resolution uses a lookup table in `config.py`:

```python
ACCOUNT_ID_SECRETS = {
    "tiktok":    "tiktok-open-id",
    "instagram": "instagram-account-id",
    "metaads":   "meta-ads-account-id",
}
```

`keyvault_client.read_token(config.ACCOUNT_ID_SECRETS[platform])` replaces the `f"{platform}-open-id"` pattern in `function_app.py` and `platform_registry.py`. Add `ACCOUNT_ID_SECRETS` to `config.py`.

### Table Storage Schema

#### Instagram Posts + Reels

**`instagramsnapshots`** — immutable, one row per (date, post).
- PartitionKey: `snapshot_date` (YYYY-MM-DD)
- RowKey: `account_id_post_id` (underscore separator)
- Properties: `snapshot_date`, `post_id`, `account_id`, `media_type` (IMAGE | VIDEO | CAROUSEL_ALBUM | REELS), `media_product_type` (POST | REELS | IGTV | AD), `caption`, `publish_time` (ISO 8601), `like_count`, `comments_count`, `shares`, `saves`, `reach`, `impressions`, `plays`, `permalink`, `thumbnail_url`, `fetched_at`

**`instagramlatest`** — one row per currently API-visible post/reel.
- PartitionKey: `account_id`
- RowKey: `post_id`
- Same properties as `instagramsnapshots`
- Deletion diff applies: posts deleted or archived on Instagram are removed from `instagramlatest` after a FetchComplete run.

#### Instagram Stories

Stories are ephemeral (disappear from the API after ~24 hours). No `instagramstorieslatest` table — the concept of "current" doesn't apply to content that expires.

**`instagramstoriessnapshots`** — one row per story per day captured.
- PartitionKey: `snapshot_date`
- RowKey: `account_id_story_id`
- Properties: `snapshot_date`, `story_id`, `account_id`, `media_type` (IMAGE | VIDEO), `publish_time`, `reach`, `impressions`, `replies`, `exits`, `permalink`, `fetched_at`
- Rows are never deleted. No deletion diff — stories expire naturally from the API.

#### Meta Ads — Ad Level

**`metaadssnapshots`** — immutable, one row per (date, ad).
- PartitionKey: `snapshot_date`
- RowKey: `ads_account_id_ad_id`
- Properties: `snapshot_date`, `report_date`, `date_start`, `date_stop`, `ad_id`, `ad_name`, `adset_id`, `adset_name`, `campaign_id`, `campaign_name`, `ads_account_id`, `currency`, `spend`, `impressions`, `clicks`, `reach`, `cpm`, `cpc`, `ctr`, `purchases`, `purchase_value`, `roas`, `fetched_at`
- **`status` omitted (MVP):** not returned by the Insights endpoint; requires a separate `/act_{id}/ads?fields=id,status` call. Add in a future iteration if needed.

**`metaadslatest`** — one row per active ad.
- PartitionKey: `ads_account_id`
- RowKey: `ad_id`
- Same properties as `metaadssnapshots`
- Deletion diff applies for `FetchComplete` runs.

**Date field semantics:** `snapshot_date` = when the pipeline ran (today); `report_date` = the day the stats cover (yesterday). These are always different. `date_start` and `date_stop` come from the insights response and equal `report_date` when `time_increment=1`.

#### Meta Ads — Campaign Level

**`metacampaignsnapshots`** — immutable, one row per (date, campaign).
- PartitionKey: `snapshot_date`
- RowKey: `ads_account_id_campaign_id`
- Properties: `snapshot_date`, `report_date`, `date_start`, `date_stop`, `campaign_id`, `campaign_name`, `ads_account_id`, `currency`, `spend`, `impressions`, `clicks`, `reach`, `cpm`, `cpc`, `ctr`, `purchases`, `purchase_value`, `roas`, `fetched_at`
- **`status` and `objective` omitted (MVP):** not returned by the Insights endpoint; require a separate `/act_{id}/campaigns?fields=id,status,objective` call. Add in a future iteration if needed.

**`metacampaignlatest`** — one row per active campaign.
- PartitionKey: `ads_account_id`
- RowKey: `campaign_id`
- Same properties as `metacampaignsnapshots`
- Deletion diff applies.

**Note:** `metaads` platform adapter runs both ad-level and campaign-level fetches in a single `run()` call. `fetch_complete = ads_complete AND campaigns_complete`. Deletion diff runs for neither table unless both fetches complete.

### Instagram API Details

**Base URL:** `https://graph.facebook.com/{META_GRAPH_API_VERSION}`
Version from `META_GRAPH_API_VERSION` app setting (default `v22.0`). Build all URLs from config — do not hardcode version.

**Posts + Reels fetch — 2 steps:**

Step 1 — list media (paginated):
```
GET /{ig-user-id}/media
  ?fields=id,caption,media_type,media_product_type,timestamp,permalink,
          thumbnail_url,like_count,comments_count
  &limit=50
  &after={cursor}
```
Pagination: cursor from `paging.cursors.after`. Stop when no `paging.next`. Sets `fetch_complete=True` on normal exit.
`media_product_type` values: `REELS`, `POST`, `IGTV`, `AD`.

Step 2 — per-media insights (one `GET` call per media item):
```
GET /{media-id}/insights
  ?metric={METRIC_SET_FOR_TYPE}
```

Metric sets by `media_product_type` (defined as `_INSIGHT_METRICS` dict in `meta_client.py`):
```python
_INSIGHT_METRICS = {
    "REELS": ["reach", "impressions", "plays", "likes", "comments", "shares", "saved", "total_interactions"],
    "POST":  ["reach", "impressions", "likes", "comments", "shares", "saved", "total_interactions"],
    "IGTV":  ["reach", "impressions", "plays", "likes", "comments", "shares", "saved", "total_interactions"],
    "AD":    ["reach", "impressions", "likes", "comments", "shares", "saved", "total_interactions"],
}
_INSIGHT_METRICS_FALLBACK = ["reach", "impressions"]  # minimal set, always supported
```

Parse response: `{item["name"]: item["values"][0]["value"] for item in data}`. Missing keys → `0`. `plays` is `0` for non-video types.

**Metric incompatibility fallback — Meta returns error `#100` when a metric is not supported for a given media type.** `fetch_instagram_insights()` must handle this:

1. First attempt: call `/{media-id}/insights?metric={full_metric_set_for_type}` (comma-joined list)
2. On `#100` error (or any `error.code == 100` in response): log the failure with metric set and media type, then retry with `_INSIGHT_METRICS_FALLBACK`
3. On fallback response: build result dict from available metrics; all others default to `0`
4. Never raise on metric incompatibility — only log and degrade gracefully
5. If even the fallback fails (non-metric error): let the exception propagate normally

```python
def fetch_instagram_insights(media_id: str, media_product_type: str, access_token: str) -> dict:
    metrics = _INSIGHT_METRICS.get(media_product_type, _INSIGHT_METRICS["POST"])
    url = f"{BASE_URL}/{media_id}/insights"
    try:
        resp = _get_with_retry(url, params={"metric": ",".join(metrics), "access_token": access_token})
        data = resp.json().get("data", [])
        if resp.json().get("error", {}).get("code") == 100:
            raise ValueError("metric_incompatible")
        return {item["name"]: item["values"][0]["value"] for item in data}
    except ValueError:
        logging.warning("Metric set incompatible for %s (%s), falling back", media_id, media_product_type)
        resp = _get_with_retry(url, params={"metric": ",".join(_INSIGHT_METRICS_FALLBACK), "access_token": access_token})
        result = {item["name"]: item["values"][0]["value"] for item in resp.json().get("data", [])}
        for m in metrics:
            result.setdefault(m, 0)
        return result
```

**Rate limit:** Instagram Graph API ~200 calls/user/hour. Step 2 adds 1 call per media item. Existing `_get_with_retry` with 3-retry exponential backoff on 429 covers this. For accounts with >100 posts, this may approach the limit; monitor Application Insights.

**Empty data:** no media → upsert nothing, `fetch_complete=True` (not an error).

**Stories fetch — non-paginated, also 2 steps:**

Step 1:
```
GET /{ig-user-id}/stories
  ?fields=id,media_type,timestamp,permalink
```

Step 2 — per-story insights:
```
GET /{story-id}/insights
  ?metric=reach,impressions,replies,exits
```

`fetch_complete` is always `True` unless exception. Empty stories list → upsert nothing, `fetch_complete=True`.

### Meta Ads API Details

**Base URL:** `https://graph.facebook.com/{META_GRAPH_API_VERSION}`

**Date range:** fetch yesterday's stats (today's are incomplete). `yesterday = (utcnow - 1 day).strftime("%Y-%m-%d")`.

**Ad-level fetch (Marketing API Insights endpoint):**
```
GET /act_{ads-account-id}/insights
  ?level=ad
  &fields=ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,
          spend,impressions,clicks,reach,cpm,cpc,ctr,
          actions,action_values,currency,date_start,date_stop
  &time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
  &time_increment=1
  &limit=50
  &after={cursor}
```

**Campaign-level fetch:**
```
GET /act_{ads-account-id}/insights
  ?level=campaign
  &fields=campaign_id,campaign_name,objective,
          spend,impressions,clicks,reach,cpm,cpc,ctr,
          actions,action_values,currency,date_start,date_stop
  &time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
  &time_increment=1
  &limit=50
  &after={cursor}
```

**Purchase action extraction — check all three action_type variants:**
```python
_PURCHASE_TYPES = {"purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"}

purchases = sum(
    int(float(a["value"])) for a in (row.get("actions") or [])
    if a["action_type"] in _PURCHASE_TYPES
)
purchase_value = sum(
    float(v["value"]) for v in (row.get("action_values") or [])
    if v["action_type"] in _PURCHASE_TYPES
)
roas = round(purchase_value / float(row["spend"]), 4) if float(row.get("spend", 0)) > 0 else 0.0
```

**Currency:** available per-row as `currency` field. Store directly — do not assume USD.

**Empty data:** no ads or campaigns for yesterday → empty list, `fetch_complete=True` (not an error).

### Token Refresh API

```
GET https://graph.facebook.com/{META_GRAPH_API_VERSION}/oauth/access_token
  ?grant_type=fb_exchange_token
  &client_id={META_APP_ID}
  &client_secret={META_APP_SECRET}
  &fb_exchange_token={CURRENT_LONG_LIVED_TOKEN}
```

Returns `{"access_token": "...", "token_type": "bearer"}`. Write `access_token` to `meta-access-token` in Key Vault. Old token remains valid briefly — no immediate invalidation.

### New Modules

**`meta_client.py`** — shared by both platforms:
- `MetaTokenProvider` — class with `get_fresh_token() -> str` and `reset()`. Module-level `_cached_token`.
- `refresh_access_token(current_token: str) -> str` — called only by `MetaTokenProvider`
- `fetch_instagram_media(access_token, ig_user_id) -> tuple[list, bool]` — steps 1 + 2, returns normalized dicts with all metrics
- `fetch_instagram_stories(access_token, ig_user_id) -> tuple[list, bool]` — steps 1 + 2
- `fetch_meta_ads(access_token, ads_account_id, date: str) -> tuple[list, bool]`
- `fetch_meta_campaigns(access_token, ads_account_id, date: str) -> tuple[list, bool]`
- `_INSIGHT_METRICS: dict` — metric sets by `media_product_type`
- `_PURCHASE_TYPES: set` — purchase action type variants
- `_get_with_retry(url, **kwargs)` — GET equivalent of TikTok's `_post_with_retry`. 15s timeout, 3 retries on 429/5xx.

**`platform_registry.py`** — add two adapters:

```python
class InstagramAdapter:
    PLATFORM = "instagram"

    def run(self) -> tuple:
        token = MetaTokenProvider.get_fresh_token()

        ig_id = keyvault_client.read_token(config.ACCOUNT_ID_SECRETS["instagram"])
        posts, posts_complete = meta_client.fetch_instagram_media(token, ig_id)
        stories, stories_complete = meta_client.fetch_instagram_stories(token, ig_id)

        snapshot_date = today_utc()
        for post in posts:
            table_storage_client.upsert_instagram_post(post, snapshot_date, ig_id)
        for story in stories:
            table_storage_client.upsert_instagram_story(story, snapshot_date, ig_id)

        current_post_ids = {p["id"] for p in posts}
        table_storage_client.run_deletion_diff("instagramlatest", ig_id, current_post_ids, posts_complete)

        if not posts_complete:
            raise RuntimeError("Instagram media fetch incomplete")

        return ig_id, len(posts) + len(stories)


class MetaAdsAdapter:
    PLATFORM = "metaads"

    def run(self) -> tuple:
        token = MetaTokenProvider.get_fresh_token()

        ads_account_id = keyvault_client.read_token(config.ACCOUNT_ID_SECRETS["metaads"])
        yesterday = yesterday_utc()

        ads, ads_complete = meta_client.fetch_meta_ads(token, ads_account_id, yesterday)
        campaigns, camp_complete = meta_client.fetch_meta_campaigns(token, ads_account_id, yesterday)

        snapshot_date = today_utc()
        for ad in ads:
            table_storage_client.upsert_meta_ad(ad, snapshot_date, ads_account_id)
        for camp in campaigns:
            table_storage_client.upsert_meta_campaign(camp, snapshot_date, ads_account_id)

        fetch_complete = ads_complete and camp_complete
        current_ad_ids = {a["ad_id"] for a in ads}
        current_camp_ids = {c["campaign_id"] for c in campaigns}
        table_storage_client.run_deletion_diff("metaadslatest", ads_account_id, current_ad_ids, fetch_complete)
        table_storage_client.run_deletion_diff("metacampaignlatest", ads_account_id, current_camp_ids, fetch_complete)

        if not fetch_complete:
            raise RuntimeError("Meta Ads fetch incomplete")

        return ads_account_id, len(ads)


REGISTRY = {
    "tiktok": TikTokAdapter,
    "instagram": InstagramAdapter,
    "metaads": MetaAdsAdapter,
}
```

### `run_deletion_diff` Refactor

Current signature in `table_storage_client.py` (Phase 1, TikTok-only):
```python
def run_deletion_diff(open_id: str, current_video_ids: set, fetch_complete: bool) -> None:
    # hardcoded to tiktoklatest
```

Phase 2 requires calling it for 4 different tables. Refactor to:
```python
def run_deletion_diff(table_name: str, partition_key: str, current_row_keys: set, fetch_complete: bool) -> None:
```

Update TikTok call in `platform_registry.py` to:
```python
table_storage_client.run_deletion_diff("tiktoklatest", open_id, current_ids, fetch_complete)
```

Tests for `run_deletion_diff` must pass `table_name` explicitly. Existing TikTok tests must be updated to use the new signature.

### Run Status Field Migration

Phase 1 writes `videos_last_run` to `pipelinerunstatus`. Phase 2 adds Instagram (posts + stories) and Meta Ads (ads). The field name `videos_last_run` is wrong for these platforms.

Phase 2 changes:
- Instagram and Meta Ads adapters write `items_last_run` to `pipelinerunstatus`
- TikTok adapter continues writing `videos_last_run` for backward compatibility (existing Excel workbook reads `/api/health`)
- `/api/health` response: return `items_last_run` if present, else fall back to `videos_last_run`

### `/api/stats` — `content_type` param

Valid for `instagram` and `metaads`. Not applicable to `tiktok` (returns HTTP 400 if provided).

**Instagram** — valid values: `posts` (default), `stories`

**Meta Ads** — valid values: `ads` (default), `campaigns`

Full routing table:

| platform | content_type | view | Routes to | Table queried |
|---|---|---|---|---|
| instagram | posts (default) | latest | `instagramlatest` | PartitionKey = account_id |
| instagram | posts (default) | history | `instagramsnapshots` | filtered by date |
| instagram | stories | history | `instagramstoriessnapshots` | filtered by date |
| instagram | stories | latest | HTTP 400 | — no latest stories table |
| metaads | ads (default) | latest | `metaadslatest` | PartitionKey = ads_account_id |
| metaads | ads (default) | history | `metaadssnapshots` | filtered by date |
| metaads | campaigns | latest | `metacampaignlatest` | PartitionKey = ads_account_id |
| metaads | campaigns | history | `metacampaignsnapshots` | filtered by date |
| tiktok | any value | any | HTTP 400 | — content_type not applicable |
| any | unknown value | any | HTTP 400 | — |

### `/api/stats` CSV Columns

The global `CSV_COLUMNS` in `function_app.py` is TikTok-only and must NOT be used for Phase 2 routes. Replace with:

```python
CSV_COLUMNS_BY_ROUTE = {
    ("tiktok",    None):        ["snapshot_date", "video_id", "open_id", "title", "description",
                                  "create_time", "duration_sec", "view_count", "like_count",
                                  "comment_count", "share_count", "share_url", "cover_url", "fetched_at"],
    ("instagram", "posts"):     ["snapshot_date", "post_id", "account_id", "media_type",
                                  "media_product_type", "caption", "publish_time",
                                  "like_count", "comments_count", "shares", "saves",
                                  "reach", "impressions", "plays",
                                  "permalink", "thumbnail_url", "fetched_at"],
    ("instagram", "stories"):   ["snapshot_date", "story_id", "account_id", "media_type",
                                  "publish_time", "reach", "impressions", "replies", "exits",
                                  "permalink", "fetched_at"],
    ("metaads",   "ads"):       ["snapshot_date", "report_date", "date_start", "date_stop",
                                  "ad_id", "ad_name", "adset_id", "adset_name",
                                  "campaign_id", "campaign_name", "ads_account_id", "currency",
                                  "spend", "impressions", "clicks", "reach", "cpm", "cpc", "ctr",
                                  "purchases", "purchase_value", "roas", "fetched_at"],
    ("metaads",   "campaigns"): ["snapshot_date", "report_date", "date_start", "date_stop",
                                  "campaign_id", "campaign_name", "ads_account_id", "currency",
                                  "spend", "impressions", "clicks", "reach", "cpm", "cpc", "ctr",
                                  "purchases", "purchase_value", "roas", "fetched_at"],
}
```

`_clean_row` and `_rows_to_csv` must accept `columns` as a parameter derived from `CSV_COLUMNS_BY_ROUTE[(platform, content_type)]`. The existing `CSV_COLUMNS` global is deprecated; remove it when Phase 2 is merged (or keep only for backward compat and replace TikTok path to use the dict).

### New Tables to Create (`setup/create_tables.py`)

```
instagramsnapshots
instagramlatest
instagramstoriessnapshots
metaadssnapshots
metaadslatest
metacampaignsnapshots
metacampaignlatest
```

7 new tables. `pipelinerunstatus` already exists (shared).

### New App Settings (Azure Function)

```
META_APP_ID              — Facebook App ID (needed for token refresh at runtime)
META_APP_SECRET          — Facebook App Secret
META_GRAPH_API_VERSION   — default v22.0 (verify against current Meta docs before implementation)
```

Add all three to `config.py` and Azure App Settings.

### One-Time OAuth Setup (`setup/one_time_oauth_meta.py`)

Facebook Login OAuth flow:

1. Build auth URL:
   ```
   https://www.facebook.com/{META_GRAPH_API_VERSION}/dialog/oauth
     ?client_id={APP_ID}
     &redirect_uri=http://localhost:8080/callback
     &scope={SCOPES}
     &response_type=code
     &state={random}
   ```

2. Open browser, capture `code` from redirect callback

3. Exchange code for short-lived token:
   ```
   GET https://graph.facebook.com/{META_GRAPH_API_VERSION}/oauth/access_token
     ?client_id=APP_ID&client_secret=APP_SECRET
     &redirect_uri=http://localhost:8080/callback&code=CODE
   ```

4. Exchange short-lived → long-lived:
   ```
   GET https://graph.facebook.com/{META_GRAPH_API_VERSION}/oauth/access_token
     ?grant_type=fb_exchange_token
     &client_id=APP_ID&client_secret=APP_SECRET
     &fb_exchange_token={SHORT_LIVED_TOKEN}
   ```

5. Fetch Instagram Business account ID:
   ```
   GET https://graph.facebook.com/{META_GRAPH_API_VERSION}/me/accounts
     → returns list of Pages; pick the one linked to the IG account

   GET https://graph.facebook.com/{META_GRAPH_API_VERSION}/{page-id}
     ?fields=instagram_business_account
     → returns { "instagram_business_account": { "id": "..." } }
   ```

6. Store in Key Vault:
   - `meta-access-token` = long-lived token
   - `instagram-account-id` = IG business account ID from step 5
   - `meta-ads-account-id` = from user input (format: `act_XXXXXXXXX`, found in Meta Ads Manager)
   - `meta-page-id` = Facebook Page ID from step 5

**Required env vars:**
```
AZURE_KEY_VAULT_URL
META_APP_ID
META_APP_SECRET
META_GRAPH_API_VERSION    # e.g. v22.0
META_ADS_ACCOUNT_ID       # user provides manually
```

### Required OAuth Permissions

**Default scope string for `setup/one_time_oauth_meta.py`:**
```
instagram_basic,instagram_manage_insights,pages_show_list,pages_read_engagement,ads_read
```

| Scope | Required for | Notes |
|---|---|---|
| `instagram_basic` | List IG media, account info | Mandatory |
| `instagram_manage_insights` | Per-media insights (reach, impressions, plays) | Mandatory |
| `pages_show_list` | List FB Pages to find linked IG account | Required during OAuth setup only |
| `pages_read_engagement` | Some IG Business insights require Page context | Mandatory for business account insights |
| `ads_read` | Read ad performance via Marketing API Insights | Mandatory for metaads |
| `business_management` | Access ad account under Business Manager | **Optional — do not include by default.** Add only if Ads API returns 403. Ad accounts not under a Business Manager (personal ad accounts) work with `ads_read` alone. |

---

## Testing Decisions

**`meta_client`**
- `MetaTokenProvider.get_fresh_token()`: first call refreshes and caches; second call returns cached token without another KV read; refresh failure raises; cache cleared by `reset()`; `reset()` called at timer start means each daily run refreshes fresh
- `MetaTokenProvider` writes `meta-token-last-refreshed-at` to Key Vault after successful refresh
- `refresh_access_token`: happy path returns token string; error key in response raises `ValueError`; 429 retries
- `fetch_instagram_media`: step 1 single page → `fetch_complete=True`; two pages → combined list; exception in step 1 → `fetch_complete=False`; step 2 metrics parsed from insights response; `plays=0` for IMAGE type
- `fetch_instagram_insights`: full metric set succeeds → returns dict; Meta error `#100` → logs warning, retries with `_INSIGHT_METRICS_FALLBACK`, fills missing keys with `0`; non-metric error → raises normally
- `fetch_instagram_stories`: non-paginated; exception → `fetch_complete=False`; empty list → `fetch_complete=True`
- `fetch_meta_ads`: `purchases` summed across all three purchase action types; `roas=0.0` when `spend=0`; pagination works; `currency` field stored; `status` field NOT in response (Insights endpoint — not expected)
- `fetch_meta_campaigns`: same extraction logic as ads; `objective` NOT in response (not expected from Insights)

**`table_storage_client`** (new methods)
- `upsert_instagram_post`: PartitionKey=`snapshot_date`, RowKey=`account_id_post_id`; all properties stored
- `upsert_instagram_story`: PartitionKey=`snapshot_date`, RowKey=`account_id_story_id`
- `upsert_meta_ad`: PartitionKey=`snapshot_date`, RowKey=`ads_account_id_ad_id`; `report_date`, `date_start`, `date_stop`, `currency` all stored; `status` not stored
- `upsert_meta_campaign`: same date fields and currency; `status`/`objective` not stored
- `run_deletion_diff(table_name, partition_key, current_row_keys, fetch_complete)`: new signature; existing TikTok test updated to pass `"tiktoklatest"` as first arg

**`platform_registry`**
- `InstagramAdapter.run()`: calls `MetaTokenProvider.get_fresh_token()`; stories failure does not block posts upsert; raises if `posts_complete=False`; returns `(ig_id, post_count + story_count)`
- `MetaAdsAdapter.run()`: calls `get_fresh_token()` independently (no instagram ordering); raises if ads OR campaigns incomplete
- Both adapters: `MetaTokenProvider` refresh failure marks that adapter as failed; other adapter attempts independently
- `timer_trigger()` calls `MetaTokenProvider.reset()` before platform loop; test verifies reset is called even when no meta platforms are configured

**`function_app`** — `/api/stats`
- `content_type=stories` + `view=history` → `instagramstoriessnapshots`
- `content_type=posts` (default) + `view=latest` → `instagramlatest`
- `content_type=stories` + `view=latest` → 400
- `content_type=anything` + `platform=tiktok` → 400
- `content_type=campaigns` + `platform=metaads` + `view=latest` → `metacampaignlatest`
- `content_type=ads` (default) + `platform=metaads` + `view=history` → `metaadssnapshots`
- Unknown `content_type` → 400
- CSV output uses `CSV_COLUMNS_BY_ROUTE[(platform, content_type)]`; TikTok uses `("tiktok", None)` key

**`config`**
- `ACCOUNT_ID_SECRETS` contains entries for `tiktok`, `instagram`, `metaads`
- `META_GRAPH_API_VERSION` defaults to `v22.0`

---

## Acceptance Criteria

Phase 2 is done when all of these pass:

- [ ] `/api/stats?platform=instagram&content_type=posts&format=csv` returns non-empty CSV with header row containing `snapshot_date,post_id,account_id,media_type,reach,impressions`
- [ ] `/api/stats?platform=instagram&content_type=stories&format=csv` returns non-empty CSV with header row containing `snapshot_date,story_id,reach,impressions,replies`
- [ ] `/api/stats?platform=metaads&content_type=ads&format=csv` returns rows where `report_date` = yesterday and `snapshot_date` = today; `spend` is float, `currency` is 3-letter code
- [ ] `/api/stats?platform=metaads&content_type=campaigns&format=csv` returns campaign-level rows (no `ad_id` column)
- [ ] Deleting an Instagram post and running the timer causes that `post_id` to disappear from `instagramlatest` after a FetchComplete run
- [ ] A story captured while active remains in `instagramstoriessnapshots` after it expires from the API
- [ ] `/api/stats?platform=instagram&content_type=stories&view=latest` returns HTTP 400
- [ ] `/api/stats?platform=tiktok&content_type=posts` returns HTTP 400
- [ ] Disabling `metaads` from `CONFIGURED_PLATFORMS` does not affect `instagram` run (and vice versa)
- [ ] `/api/health` returns separate rows for `platform=instagram` and `platform=metaads`; each includes `token_age_days`; when age >= 45, includes `token_warning`
- [ ] Token refresh failure causes both platforms to fail their individual run but does not crash the entire function — `tiktok` and other platforms still run
- [ ] `MetaTokenProvider` refreshes the token exactly once per timer invocation even when both `instagram` and `metaads` are configured
- [ ] Running the timer twice on the same day does not create duplicate rows in any `*snapshots` table
- [ ] `setup/one_time_oauth_meta.py` completes without `business_management` scope for a personal ad account
- [ ] TikTok existing tests still pass after `run_deletion_diff` signature refactor

---

## Tables Summary

| Table | Platform | Type | Notes |
|---|---|---|---|
| `instagramsnapshots` | instagram | history | Posts + Reels. Never deleted. |
| `instagramlatest` | instagram | current | Posts + Reels. Deletion diff on FetchComplete. |
| `instagramstoriessnapshots` | instagram | history | Stories only. No latest table. Never deleted. |
| `metaadssnapshots` | metaads | history | Ad-level. Never deleted. |
| `metaadslatest` | metaads | current | Ad-level. Deletion diff on FetchComplete. |
| `metacampaignsnapshots` | metaads | history | Campaign-level. Never deleted. |
| `metacampaignlatest` | metaads | current | Campaign-level. Deletion diff on FetchComplete. |

---

## Out of Scope

- Instagram Direct Messages
- Meta Ads adset-level stats (between campaign and ad — omitted to limit table count)
- Instagram Shopping / product tags
- Meta Business Suite metrics (separate API, separate auth)
- Reels audio attribution, remix stats
- Attribution window configuration for Meta Ads (defaults: 7-day click, 1-day view)
- Automated token re-authorization (if long-lived token expires, manual re-run of `setup/one_time_oauth_meta.py` required)

---

## Setup Checklist

- [ ] Verify `META_GRAPH_API_VERSION` against current Meta API docs before implementation (default: `v22.0`)
- [ ] Facebook App has all required permissions approved (see permissions table above)
- [ ] Instagram Business account connected to a Facebook Page
- [ ] `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_API_VERSION` added to Azure App Settings
- [ ] Run `setup/one_time_oauth_meta.py` → 4 secrets stored in Key Vault
- [ ] Run `setup/create_tables.py` → 7 new tables created
- [ ] `CONFIGURED_PLATFORMS=tiktok,instagram,metaads` updated in App Settings
- [ ] `ACCOUNT_ID_SECRETS` added to `config.py`
- [ ] Redeploy function app
- [ ] Trigger timer manually and verify `/api/health?platform=instagram` and `/api/health?platform=metaads`
