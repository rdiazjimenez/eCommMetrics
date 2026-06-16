# ADR 0004: Per-Platform Failure Isolation in Multi-Platform Timer

**Date:** 2026-05-25  
**Status:** Accepted

## Context

The Timer Trigger iterates over all configured platforms. If one platform fails (token rotation error, rate limit, Table Storage error), a decision is needed on whether subsequent platforms still run.

`pipelinerunstatus` tracks health per platform. The intent is that platforms are operationally independent.

## Decision

Each platform runs inside its own try/except block. One platform's failure does not abort others. Every platform writes its own `pipelinerunstatus` row (ok or error) regardless of other platforms' outcomes.

After all platforms have been attempted, if any platform failed, the timer raises `MultiPlatformRunError` with a summary of which platforms failed. This ensures Azure marks the function execution as failed and Application Insights fires alerts.

The timer does **not** re-raise only when all platforms fail — that would allow partial failures to be invisible to Azure-level monitoring while appearing healthy from outside.

```
failures = []
for each configured platform:
    try: fetch -> upsert -> pipelinerunstatus(ok)
    except: pipelinerunstatus(error) -> failures.append(platform) -> continue
if failures:
    raise MultiPlatformRunError(summary)
```

## Alternatives Considered

**Fail-fast (abort on first failure)** — rejected. A TikTok token expiry would silently prevent Instagram and YouTube from running. Instagram's `pipelinerunstatus` row would show a stale timestamp with no indication it was skipped, not failed.

**Swallow all failures, never re-raise** — rejected. Azure function execution would always appear successful even when platforms are broken. `pipelinerunstatus` would show errors but Azure Monitor alerts would never fire.

**Re-raise only when all platforms fail** — rejected. Partial failures become invisible to Azure-level monitoring. A developer could see healthy function executions while one platform has been broken for days.

## Consequences

- Adding a new platform adds one more iteration to the timer loop. No structural changes.
- A single broken platform does not degrade others.
- Azure alerts fire correctly for any partial failure.
- `pipelinerunstatus` is the authoritative per-platform health record; Azure execution status is the aggregate signal.
