## Why

The Python runtime is intended to reuse the same permission model as the Node runtime, but the current `PyodideRuntimeDriver.exec()` path forwards `options.env` into the worker without filtering it through `permissions.env`. That makes the active Python change spec ahead of the code and creates a cross-runtime policy mismatch.

## What Changes

- Filter Python `exec()` env overrides through the existing `SystemDriver.permissions.env` gate before applying them in the Pyodide worker.
- Add regression coverage showing denied env overrides stay hidden by default and allowed env overrides remain available when explicitly permitted.
- Record the fix in the internal to-do/friction tracking so the repo state matches the code.

## Impact

- Affected code: `packages/secure-exec/src/python/driver.ts`
- Affected tests: `packages/secure-exec/tests/runtime-driver/python.test.ts`
- Affected specs: `python-runtime`
