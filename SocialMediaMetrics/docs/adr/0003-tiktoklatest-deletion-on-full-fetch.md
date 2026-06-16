# ADR 0003: Delete from tiktoklatest When Video Disappears from API

**Date:** 2026-05-25  
**Status:** Accepted

## Context

When a TikTok video is deleted, made private, or removed by TikTok, the API stops returning it. The timer upserts only what the API returns, so ghost rows accumulate in `tiktoklatest` if no deletion logic exists. `tiktoklatest` is intended to reflect currently visible videos, not all videos ever seen.

## Decision

After a successful full fetch, the timer computes the diff between the current API video IDs and the existing `tiktoklatest` rows for that AccountId. Rows whose `video_id` is absent from the current API response are deleted from `tiktoklatest`.

**Safety guard:** deletion diff runs only after a complete, successful fetch of all pages. If the TikTok API fails, times out, paginates incompletely, or rate-limits mid-fetch, no rows are deleted from `tiktoklatest` for that run.

`tiktoksnapshots` is never affected — historical rows are immutable regardless of whether the video still exists on TikTok.

## Two-Table Semantics

| Table | Meaning |
|---|---|
| `tiktoksnapshots` | Immutable historical observations. Never deleted. |
| `tiktoklatest` | Currently API-visible videos with latest stats. Reflects what TikTok returns today. |

## Alternatives Considered

**Leave ghost rows** — rejected. `tiktoklatest` would mean "latest known for anything ever seen," which misleads Excel users who assume the table reflects their current video catalog.

**Mark deleted with `deleted_at` column** — rejected. Requires Excel users to filter `WHERE deleted_at IS NULL` on every query. Pushes the cleanup responsibility to the consumer. `tiktoklatest` should be clean by definition.

## Consequences

- Timer must load existing `tiktoklatest` row keys for the AccountId after a successful full fetch and delete any not present in the current API response.
- Partial fetch (pagination error mid-run) must abort the deletion step. The run is marked failed in `pipelinerunstatus`.
- A video that temporarily disappears from TikTok (e.g., under review) and reappears later will be removed from `tiktoklatest` on the run it disappears and re-added when it reappears. Its history in `tiktoksnapshots` is unaffected.
