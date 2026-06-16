# ADR 0002: Single /api/stats Endpoint with platform Param

**Date:** 2026-05-25  
**Status:** Accepted

## Context

ECommMetrics will serve stats from multiple platforms (TikTok, Instagram, YouTube, Meta Ads, Pinterest). A decision is needed on whether to expose one HTTP endpoint per platform or one unified endpoint.

Excel Power Query URLs are baked into workbooks. Changing them requires user action. The endpoint shape should be stable across platform additions.

## Decision

One endpoint: `/api/stats`. Platform is a required query parameter: `?platform=tiktok`.

Full URL shape:
```
/api/stats?platform=tiktok&accountId=...&view=latest|history&format=csv|json&from=...&to=...&limit=...&code=KEY
```

Internal routing dispatches to a platform-specific reader module based on the `platform` param. Each reader module queries the correct platform tables (`tiktoklatest`, `tiktoksnapshots`, etc.).

`/api/health` follows the same pattern: one endpoint, `platform` param optional (returns all platforms if omitted).

## Alternatives Considered

**Per-platform routes** (`/api/tiktok-stats`, `/api/instagram-stats`) — rejected. Excel Power Query URLs would need to change when platforms are added or renamed. Two functions to deploy and monitor instead of one. Isolation benefit is achievable within one function by keeping reader modules separate.

## Consequences

- Excel Power Query URL pattern is stable: adding Instagram means changing `platform=tiktok` to `platform=instagram`, nothing else.
- Each new platform adds a reader module and two tables. The endpoint itself does not change.
- A single bad deploy can affect all platforms simultaneously. Mitigated by isolated reader modules and per-platform error handling inside the function.
