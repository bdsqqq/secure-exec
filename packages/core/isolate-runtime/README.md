# Isolate Runtime Source Inventory

This directory is the source of truth for host-injected isolate runtime code.

## Source Layout

- Inject entrypoints: `isolate-runtime/src/inject/*.ts`
- Shared runtime helpers/contracts: `isolate-runtime/src/common/**`

## Mapping

- `src/shared/require-setup.ts` -> `isolate-runtime/src/inject/require-setup.ts`
- `src/bridge-setup.ts` (`createInitialBridgeGlobalsCode`) -> `isolate-runtime/src/inject/bridge-initial-globals.ts`
- `src/bridge-loader.ts` bridge global attachment wrapper -> `isolate-runtime/src/inject/bridge-attach.ts`
- `src/index.ts` dynamic-import setup snippet -> `isolate-runtime/src/inject/setup-dynamic-import.ts`
- `src/index.ts` `_fs` facade setup snippet -> `isolate-runtime/src/inject/setup-fs-facade.ts`
- `src/index.ts` CommonJS mutable globals init snippet -> `isolate-runtime/src/inject/init-commonjs-module-globals.ts`
- `src/index.ts` CommonJS file globals snippet -> `isolate-runtime/src/inject/set-commonjs-file-globals.ts`
- `src/index.ts` global descriptor policy snippet -> `isolate-runtime/src/inject/apply-custom-global-policy.ts`
- `src/index.ts` timing mitigation snippets ->
  - `isolate-runtime/src/inject/apply-timing-mitigation-off.ts`
  - `isolate-runtime/src/inject/apply-timing-mitigation-freeze.ts`
- `src/index.ts` process override snippets ->
  - `isolate-runtime/src/inject/override-process-env.ts`
  - `isolate-runtime/src/inject/override-process-cwd.ts`
- `src/index.ts` stdin override snippet -> `isolate-runtime/src/inject/set-stdin-data.ts`
- Shared global exposure helper source -> `isolate-runtime/src/inject/global-exposure-helpers.ts`
- `src/execution.ts` script-result eval wrapper -> `isolate-runtime/src/inject/eval-script-result.ts`

Build output:

- Compiled scripts: `dist/isolate-runtime/**`
- Generated manifest used by host runtime: `src/generated/isolate-runtime.ts`
