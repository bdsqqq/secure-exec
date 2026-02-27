## 1. Add shared boundary size guards

- [x] 1.1 Define runtime constants/helpers for maximum isolate-boundary base64 transfer size and maximum isolate-originated JSON payload size in `packages/sandboxed-node/src/index.ts`, including explicit byte-measurement rules (base64 serialized bytes and JSON UTF-8 bytes).
- [x] 1.2 Implement deterministic overflow error construction so guard failures return stable bridge/runtime errors instead of process-fatal behavior.

## 2. Guard base64 file-transfer paths

- [x] 2.1 Add outbound size validation in `readFileBinaryRef` before returning large base64 payloads across the isolate boundary.
- [x] 2.2 Add inbound size validation in `writeFileBinaryRef` before base64 decode/allocation.
- [x] 2.3 Add targeted tests in `packages/sandboxed-node/tests/payload-limits.test.ts` for oversized and in-limit binary read/write payloads.

## 3. Guard host-side JSON parsing

- [x] 3.1 Enumerate all isolate-originated `JSON.parse` callsites in `packages/sandboxed-node/src/index.ts` (currently 10) and route each through a shared pre-parse size-check helper.
- [x] 3.2 Extend `packages/sandboxed-node/tests/payload-limits.test.ts` with regression tests that verify oversized JSON payloads fail deterministically and in-limit payloads preserve current behavior.

## 4. Sync docs and verify

- [x] 4.1 Update `docs-internal/friction/sandboxed-node.md` with the boundary-size guardrail behavior and fix notes.
- [x] 4.2 Update `docs/security-model.mdx` to document isolate-boundary payload limits, deterministic overflow behavior, and compatibility trade-offs.
- [x] 4.3 Run focused validation: `pnpm --filter sandboxed-node test -- tests/payload-limits.test.ts` and `pnpm --filter sandboxed-node check-types`.

## 5. Add bounded payload-limit configurability

- [x] 5.1 Extend `NodeProcessOptions` with host-configurable payload-limit overrides for base64 transfer and isolate-originated JSON parsing.
- [x] 5.2 Enforce strict payload-limit validation bounds so invalid values fail construction and limits cannot be disabled.
- [x] 5.3 Extend `packages/sandboxed-node/tests/payload-limits.test.ts` with in-range override behavior and out-of-range validation tests.
