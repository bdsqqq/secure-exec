# Kernel Consolidation — Proofing Audit (US-039)

**Date:** 2026-03-24
**Branch:** ralph/kernel-consolidation

## Summary

Adversarial review of kernel implementation completeness. The kernel socket
table, process table, and network stack are fully operational and wired into
both the KernelNodeRuntime and WasmVM runtimes. The legacy adapter-based
path (used by `createNodeRuntimeDriverFactory` / original `NodeRuntime` API)
still retains its own networking state as a backward-compatible fallback.

## Verification Results

### ✅ WasmVM driver.ts — CLEAN

- No `_sockets` Map
- No `_nextSocketId` counter
- All socket ops route through `kernel.socketTable` (create/connect/send/recv/close)
- TLS-upgraded sockets correctly bypass kernel recv via `_tlsSockets` Map

### ⚠️ Node.js driver.ts — LEGACY ADAPTER STATE REMAINS

**Found in `createDefaultNetworkAdapter()`:**
- `servers` Map (line 294) — tracks HTTP servers created via adapter path
- `ownedServerPorts` Set (line 296) — SSRF loopback exemption for adapter-managed servers
- `upgradeSockets` Map (line 298) — WebSocket upgrade relay state

**Already removed:**
- `netSockets` Map — ✅ gone

**Why it remains:** `createDefaultNetworkAdapter()` is the `NetworkAdapter`
implementation used by `createNodeRuntimeDriverFactory()`, which does NOT
wire up kernel routing. This factory is used by the original `NodeRuntime`
API, benchmarks, and many test suites. Removing the adapter path would
break the public API.

### ⚠️ Node.js bridge/network.ts — EVENT ROUTING MAP REMAINS

**Found:**
- `activeNetSockets` Map (line 2042) — maps socket IDs to bridge-side
  `NetSocket` instances for dispatching host events (connect, data, end,
  close, error)

**Already removed:**
- `serverRequestListeners` Map — ✅ gone (only mentioned in a JSDoc comment)

**Why it remains:** The bridge runs inside the V8 isolate and needs a local
dispatch table to route events from the host to the correct `NetSocket`
instance. This is event routing only (analogous to `childProcessInstances`
in bridge/child-process.ts), not socket state management. The kernel tracks
actual socket state.

### ✅ http.createServer() — KERNEL PATH EXISTS

**Kernel path (bridge-handlers.ts:2204–2323):**
`socketTable.create() → bind() → listen({ external: true })` → kernel
accept loop feeds connections through `http.createServer()` for HTTP
parsing (not bound to any port).

**Adapter fallback (bridge-handlers.ts:2326–2372):**
Falls through to `adapter.httpServerListen()` when `socketTable` is not
provided. Only reachable from the legacy `createNodeRuntimeDriverFactory`
path.

### ✅ net.connect() — KERNEL PATH EXISTS

**Kernel path (bridge-handlers.ts:990–1010):**
`socketTable.create(AF_INET, SOCK_STREAM, 0, pid)` →
`socketTable.connect(socketId, { host, port })` → async read pump.

**Direct host fallback (bridge-handlers.ts:826–849):**
`net.connect({ host, port })` with local `sockets` Map. Only reachable
when `buildNetworkSocketBridgeHandlers` is called without `socketTable`.

### ⚠️ SSRF Validation — DUPLICATED

**Kernel-aware path (bridge-handlers.ts:1966–2048):**
- `isPrivateIp()`, `isLoopbackHost()`, `assertNotPrivateHost()` with
  `socketTable.findListener()` for loopback exemption
- Used by `networkFetchRaw` and `networkHttpRequestRaw` handlers

**Legacy adapter path (driver.ts:194–279):**
- Duplicate `isPrivateIp()`, `isLoopbackHost()`, `assertNotPrivateHost()`
  with `ownedServerPorts` Set for loopback exemption
- Used by `createDefaultNetworkAdapter()` fetch/httpRequest methods
- Comment says "Primary SSRF check is in bridge-handlers.ts. Adapter
  validates for defense-in-depth."

**Kernel permission path (socket-table.ts:219):**
- `checkNetworkPermission()` enforces deny-by-default at the socket level
- Applied to connect(), listen(), send() operations

**Host adapter (host-network-adapter.ts):**
- ✅ No SSRF validation — clean delegation

### ✅ Kernel Network Permission Enforcement

`checkNetworkPermission()` is called at:
- `listen()` (line 305)
- `connect()` — external path (line 506)
- `send()` — external path (line 577)
- `sendTo()` — external path (line 697)
- `externalListen()` (line 772)

Loopback connections bypass permission checks (correct behavior).

## Remaining Gaps (Future Work)

1. **Remove legacy adapter networking state** — Once `NodeRuntime` is
   migrated to use `KernelNodeRuntime` as its backing implementation,
   remove `servers`, `ownedServerPorts`, `upgradeSockets` from
   `createDefaultNetworkAdapter()` and the adapter fallback paths in
   `bridge-handlers.ts`.

2. **Remove duplicate SSRF validation** — Once the adapter fallback is
   removed, delete the duplicate `isPrivateIp`/`assertNotPrivateHost` from
   driver.ts. The bridge-handlers.ts kernel-aware version + kernel
   `checkNetworkPermission()` will be the single source of truth.

3. **Remove bridge `activeNetSockets` Map** — Once the bridge-side
   `NetSocket` class routes through kernel sockets (instead of dispatching
   host events), the bridge-side dispatch map can be removed.

4. **Consolidate `isPrivateIp` export** — driver.ts exports `isPrivateIp`
   which is imported by test files (ssrf-protection.test.ts). Move to
   `@secure-exec/core` kernel utilities so it can be shared.
