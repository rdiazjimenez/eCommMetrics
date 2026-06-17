# Repository Structure

This repo is split into two independent areas:

| Folder | Contents |
|---|---|
| `SocialMediaMetrics/` | Azure Functions pipeline — ingests stats from TikTok, Instagram, Meta Ads into Azure Table Storage, served via HTTP endpoints to Excel Power Query |
| `ShopifyMetrics/` | Power Query M code (`MCode_Export/`) — connects directly from Excel to Shopify via its native connector; no Azure infrastructure |

Each area is self-contained. `SocialMediaMetrics/` is a deployable Azure Functions app. `ShopifyMetrics/` is a collection of M functions/queries exported for reuse in Power BI / Excel.

---

# Domain Glossary

## Platform

A social media or content distribution service from which stats are ingested via the pipeline.

| Platform name | Status | Content |
|---|---|---|
| `tiktok` | **Live (Phase 1)** | Videos |
| `instagram` | Phase 2 | Posts, Reels, Stories |
| `metaads` | Phase 2 | Ads + Campaigns (paid) |
| `youtube` | Phase 3+ | Videos |
| `pinterest` | Phase 3+ | Pins |

Shopify is out of scope for this pipeline — it lives in `ShopifyMetrics/` and connects directly from Excel via its native connector.

---

# ShopifyMetrics Glossary

## fn** / q** Query Pair

Power Query auto-generates a function query (`fn**`) from its paired definition query (`q**`) when the `q**` query returns a function. The `fn**` is a read-only artifact — it cannot be modified directly. All edits go in the `q**` file. The `fn**` simply exposes the function for invocation by other queries.

Example: `qGetSalesBreakdownByPeriod.pq` defines the function → Power Query creates `fnGetSalesBreakdownByPeriod` automatically.

## ParamHistoricalTable

Named range `TableHistorical` in the Excel workbook. Points to the accumulated output of a self-referencing query. On first run, the named range is empty (null). After the first run loads data to `TableHistorical`, subsequent refreshes read it as the prior cumulative dataset.

## RefreshDate (ParamReportRefreshDate)

Threshold date for incremental refresh. Periods before this date that already exist in `TableHistorical` are skipped (not re-fetched from API). Periods on or after this date are always re-fetched regardless of historical presence, to capture corrections or late-arriving data.

Instagram organic content and Meta Ads paid content are two separate platform names sharing one Facebook token in Key Vault.

## Pipeline

The automated data flow: Platform API → Azure Function (Timer) → Azure Table Storage → Azure Function (HTTP) → Excel Power Query. One pipeline per platform.

## RunStatus

Operational metadata about whether a platform pipeline is healthy. Not domain data. Not a Snapshot. Stored in one shared table (`pipelinerunstatus`) across all platforms.

Schema:
- PartitionKey = platform name (e.g. `"tiktok"`, `"instagram"`, `"metaads"`)
- RowKey = account identifier (platform-specific, see AccountId)
- Properties: `last_attempt_at`, `last_success_at`, `last_error_at`, `last_error_message`, `status` (`ok` | `error` | `unknown`)

## AccountId

The cross-platform identifier for the account, channel, or profile that a pipeline runs on behalf of. Used in shared surfaces (`pipelinerunstatus`, HTTP endpoints).

Platform-native equivalents — stored in Key Vault and used internally:

| Platform | Key Vault secret | Value |
|---|---|---|
| `tiktok` | `tiktok-open-id` | TikTok `open_id` |
| `instagram` | `instagram-account-id` | Instagram Business account ID |
| `metaads` | `meta-ads-account-id` | Ad account ID (`act_XXXXXXXXX`) |
| `youtube` | TBD | `channel_id` |
| `pinterest` | TBD | `advertiser_id` |

HTTP parameter name: `accountId`

Resolution rule for `/api/stats` and `/api/health`:
- `accountId` provided → use it directly
- `accountId` omitted, one account configured for that platform → resolve from Key Vault, use internally
- `accountId` omitted, multiple accounts, no default → HTTP 400

Platform-native IDs are never exposed at the HTTP layer. All external surfaces use `accountId`.

## HTTP Endpoints

Two system-level endpoints, both cross-platform:

```
GET /api/stats?platform=tiktok&accountId=...&view=latest|history&format=csv|json&from=...&to=...&limit=...&content_type=posts|stories&code=KEY
GET /api/health?platform=tiktok&accountId=...
```

`content_type` param (Phase 2, Instagram only):
- `posts` (default) — routes to `instagramsnapshots` / `instagramlatest`
- `stories` — routes to `instagramstoriessnapshots`
- Unknown value → HTTP 400
- Ignored / not applicable for non-instagram platforms → HTTP 400

## Table Naming Convention

Pattern: `{platform}{tabletype}`

**Phase 1 — TikTok:**
| Table | Type | Notes |
|---|---|---|
| `tiktoksnapshots` | history | One row per (date, video). Never deleted. |
| `tiktoklatest` | current | One row per API-visible video. Deletion diff on FetchComplete. |

**Phase 2 — Instagram:**
| Table | Type | Notes |
|---|---|---|
| `instagramsnapshots` | history | Posts + Reels. Never deleted. |
| `instagramlatest` | current | Posts + Reels. Deletion diff on FetchComplete. |
| `instagramstoriessnapshots` | history | Stories only. No latest table (ephemeral content). Never deleted. |

**Phase 2 — Meta Ads:**
| Table | Type | Notes |
|---|---|---|
| `metaadssnapshots` | history | Ad-level. Never deleted. |
| `metaadslatest` | current | Ad-level. Deletion diff on FetchComplete. |
| `metacampaignsnapshots` | history | Campaign-level. Never deleted. |
| `metacampaignlatest` | current | Campaign-level. Deletion diff on FetchComplete. |

**Shared (all platforms):**
| Table | Notes |
|---|---|
| `pipelinerunstatus` | One row per (platform, AccountId). |

## Token Strategy by Platform

| Platform | Token type | Expiry | Rotation |
|---|---|---|---|
| TikTok | Refresh token (OAuth 2.0 PKCE) | ~1 year | Token invalidated on use — write new before API call |
| Instagram | Long-lived User Access Token | 60 days | Not invalidated on refresh — extend at each daily run |
| Meta Ads | Same token as Instagram | 60 days | Same rotation, same Key Vault secret (`meta-access-token`) |

Meta token refresh: `GET /oauth/access_token?grant_type=fb_exchange_token`. Old token remains valid briefly after refresh (unlike TikTok).

Key Vault secrets for Phase 2:
```
meta-access-token        — shared by instagram + metaads
instagram-account-id     — Instagram Business account ID
meta-ads-account-id      — Ad account ID (act_XXXXXXXXX)
meta-page-id             — Facebook Page ID linked to Instagram account
```
App Settings (not secrets): `META_APP_ID`, `META_APP_SECRET` — needed for token refresh at runtime.

## MultiPlatformRunError

An exception raised by the Timer Trigger after all configured platforms have been attempted, when one or more failed. Ensures Azure marks the function execution as failed even when some platforms succeeded.

```
failures = []
for each configured platform:
    try: fetch, upsert, write pipelinerunstatus(ok)
    except: write pipelinerunstatus(error), append to failures, continue
if failures:
    raise MultiPlatformRunError(failed_platforms)
```

One platform failure does not abort others.

## FetchComplete

A boolean flag set to `True` only when the pagination loop exits normally — all pages returned, final page has `has_more = false` (or equivalent). Any exception, timeout, auth failure, or rate-limit exhaustion leaves it `False`.

Deletion diff (removing rows from `*latest` tables) runs only when `FetchComplete = True`. A partial fetch must never trigger deletions.

Instagram Stories: non-paginated — `fetch_complete` is always `True` unless an exception is raised.

Meta Ads: `fetch_complete = ads_complete AND campaigns_complete`. Both must succeed for deletion diff to run on either table.

## ContentItem

The atomic unit of content on a given platform.

| Platform | ContentItem | ID field | Deletion diff? |
|---|---|---|---|
| TikTok | Video | `video_id` | Yes |
| Instagram | Post / Reel | `post_id` | Yes |
| Instagram | Story | `story_id` | No (ephemeral, no latest table) |
| Meta Ads | Ad | `ad_id` | Yes |
| Meta Ads | Campaign | `campaign_id` | Yes |
| YouTube | Video | `video_id` | TBD |
| Pinterest | Pin | `pin_id` | TBD |

## Snapshot

Stats for a ContentItem captured at a specific date. Values are cumulative lifetime totals, not daily increments.

A row with `snapshot_date = 2026-05-25, view_count = 12500` means: "as of 2026-05-25, this item had 12,500 total lifetime views."

**Exception — Meta Ads:** Ad spend and impressions are reported per day (not cumulative). A Meta Ads snapshot row represents stats for `snapshot_date` only, not lifetime totals.

**Delta** (derived, not stored): incremental stats between two Snapshots. For organic platforms: `view_count[date_2] - view_count[date_1]`. For Meta Ads: each row is already a daily delta.
