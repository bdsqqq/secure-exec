## 1. Define Global Exposure Helper and Policy

- [x] 1.1 Add a shared helper for exposing globals with descriptor policy (hardened vs mutable) and document default behavior (`writable: false`, `configurable: false` for custom globals).
- [x] 1.2 Add/maintain a canonical inventory of custom non-stdlib globals with explicit classification: hardened globals vs required mutable runtime-state globals.

## 2. Migrate Runtime and Bridge Global Exposure Call Sites

- [x] 2.1 Replace manual custom-global assignments in bridge modules with helper-based hardened exposure.
- [x] 2.2 Replace manual custom-global assignments in Node runtime isolate bootstrap/setup with helper-based hardened exposure.
- [x] 2.3 Align browser worker custom-global exposure with the same policy model where equivalent custom control-plane globals are exposed.
- [x] 2.4 Ensure stdlib global exposure paths remain compatibility-oriented and are not force-frozen solely by this policy.
- [x] 2.5 Ensure every custom global exposure appears in the canonical inventory with classification/rationale in the same change.

## 3. Add Regression and Compatibility Coverage

- [x] 3.1 Add exhaustive tests that verify every hardened custom global in the inventory cannot be overwritten or redefined.
- [x] 3.2 Add compatibility tests verifying stdlib globals remain Node-compatible and mutable allowlisted runtime-state globals still function.
- [x] 3.3 Run focused sandboxed-node validation (`pnpm vitest run <targeted-tests>`, `pnpm tsc --noEmit` or package type-check equivalent) and capture known unrelated failures if present.

## 4. Update Documentation and Friction Tracking

- [x] 4.1 Update compatibility/friction documentation to record the custom-global hardening policy and its rationale.
- [x] 4.2 Document intentional exceptions (stdlib compatibility and mutable runtime-state globals) and reference the canonical inventory in relevant runtime/bridge docs.
