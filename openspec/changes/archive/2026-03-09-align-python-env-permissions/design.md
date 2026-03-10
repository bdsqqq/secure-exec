## Context

`NodeExecutionDriver` already filters per-execution env overrides with `filterEnv(...)` before they reach sandbox code. `PyodideRuntimeDriver` filters constructor-level runtime env, but its `exec()` request path currently passes `options.env` through unchanged.

## Decision

Filter Python `exec()` env overrides with the existing shared `filterEnv(...)` helper before sending them to the worker.

## Rationale

- Keeps Python permission behavior aligned with the Node runtime contract.
- Reuses the existing `permissions.env` decision model instead of introducing Python-specific policy logic.
- Fixes the contract at the host boundary, so the worker only sees already-approved env keys.

## Validation

Add Python runtime-driver tests that verify:

1. Env overrides are denied by default.
2. Env overrides are visible when `permissions.env` explicitly allows them.
