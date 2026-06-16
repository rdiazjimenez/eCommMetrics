# ADR 0001: Per-Platform Domain Tables, Shared Run Status Table

**Date:** 2026-05-25  
**Status:** Accepted

## Context

ECommMetrics ingests ContentItems from multiple platforms: TikTok, Instagram, YouTube, Meta Ads, Pinterest. Each platform's ContentItem has a different shape — TikTok Videos have `view_count`, `like_count`, `share_count`; Pinterest Pins have `save_count`, `click_count`; Meta Ads have `spend`, `impressions`, `ROAS`. Forcing all platforms into one unified schema would require either nullable columns for every platform-specific field, or a key-value blob that loses queryability.

Run status (did the pipeline succeed? when? how many items?) is operational metadata with the same shape for every platform.

## Decision

**Domain tables are per-platform.** Naming pattern: `{platform}{tabletype}` — e.g. `tiktoksnapshots`, `tiktoklatest`, `instagramsnapshots`, `instagramlatest`. Each table owns its own schema.

**The run status table is shared across all platforms.** One table: `pipelinerunstatus`. PartitionKey = platform name, RowKey = account identifier.

## Alternatives Considered

**Unified domain table** (`platformstats`, platform column) — rejected. Platforms have incompatible schemas. Nullable columns everywhere or a key-value blob. No benefit over per-platform tables.

**Unified table with JSON column for platform-specific fields** — rejected. Loses type safety and queryability in Table Storage.

**Per-platform run status tables** — rejected. Run status has the same shape for all platforms. Splitting it adds tables with no benefit. Cross-platform monitoring (a single `/api/health` response) becomes harder.

## Consequences

- Each new platform adds two new tables (`{platform}snapshots`, `{platform}latest`) and one row in `pipelinerunstatus`.
- `/api/health` is genuinely cross-platform: one endpoint shows all pipeline statuses.
- No shared abstraction layer in code is required; each platform's ingestion module is independent.
