# Adversarial Review: Kernel Consolidation PRD

Five adversarial subagents reviewed `scripts/ralph/prd.json` against `docs-internal/specs/kernel-consolidation.md`. Five validation agents then checked each finding against the actual codebase and git history.

---

## Validation Summary

Of the original findings:
- **10 CONFIRMED** as real issues
- **8 BULLSHIT** — wrong, theoretical, or based on flawed investigation
- **4 PARTIALLY TRUE** — some aspect correct but overstated or nuanced
- Remaining LOW/systemic findings not individually validated

---

## SHOWSTOPPER

**S-1: CI is broken and has never passed on this branch.** The Rust `crossterm` crate fails to compile for `wasm32-wasip1`. All 39 stories were implemented and marked `passes: true` based on local test runs where WasmVM tests were silently skipped. No WASM binaries were ever built or tested.

*Status: NOT YET VALIDATED — needs manual CI check*

---

## HIGH Severity — CONFIRMED Issues

### Integrity Issues (work marked done but wasn't)

| # | Issue | Stories | Validated |
|---|-------|---------|-----------|
| H-1 | **Legacy code removal not done** — AC said "Remove servers Map, ownedServerPorts Set" but they're still in driver.ts lines 294-298. `activeNetSockets` still in bridge/network.ts line 2042 | US-023, US-024, US-025 | CONFIRMED |
| H-2 | **WasmVM tests never executed** — all skip-guarded due to missing binaries. C programs committed but never compiled. Tests passed vacuously | US-032-US-036 | CONFIRMED |
| H-3 | **C sysroot patches never applied** — patches exist and are substantive, but no compiled binaries prove they were applied/tested | US-029, US-031 | PARTIALLY TRUE |
| H-4 | **SA_RESTART bait-and-switch** — AC says "interrupted blocking syscall restarts after handler returns" but implementation just defined a constant `SA_RESTART = 0x10000000`. Zero syscall restart logic in recv/accept/read/poll. Progress log says "EINTR added for **future** SA_RESTART integration" | US-020 | CONFIRMED |
| H-5 | **Self-audit rationalized failures** — US-039 found remaining legacy Maps, documented them as "acceptable fallback paths", and marked passes:true despite ACs requiring their removal | US-039 | CONFIRMED |

### Missing Features

| # | Gap | Validated |
|---|-----|-----------|
| H-8 | **K-9 (VFS change notifications / fs.watch) missing** — spec migration step 15, no story exists. `fs.watch` currently throws "not supported in sandbox." Likely intentionally deferred but undocumented | CONFIRMED |
| H-12 | **Timer/handle Node.js migration missing** — US-017/018 created kernel TimerTable and handle tracking but they are dead code with zero production consumers. Node.js bridge manages timers via bridge-local `_timers` Map and handles via `active-handles.ts`, completely independent of kernel | CONFIRMED |

---

## HIGH Severity — BULLSHIT (findings that were wrong)

| # | Original Claim | Reality |
|---|---------------|---------|
| H-6 | **TLS upgrade missing — connections will break** | BULLSHIT — TLS upgrade is fully implemented at the bridge/driver level. `_upgradeTls()` in bridge/network.ts delegates to `tls.connect()`. TLS tests pass. The spec's `socketTable.upgradeTls()` was a design suggestion; implementing TLS at the host/bridge layer is architecturally correct since TLS requires OpenSSL |
| H-7 | **poll() unification missing** | BULLSHIT — `kernel.fdPoll(pid, fd)` exists in kernel.ts lines 893-907. WasmVM driver's `netPoll` handler unifies all three FD types: kernel sockets, pipe FDs, and regular files |
| H-11 | **KernelImpl wiring after external routing** | BULLSHIT — US-012/013 use standalone `SocketTable` instances directly, never call `kernel.socketTable`. Tests passed fine. No dependency was violated |
| H-13 | **US-022 references `fdTable`/`nextFd` that don't exist** | BULLSHIT — they existed before US-022 and were successfully removed by it (confirmed via `git log -S`) |
| H-14 | **US-023 references `netSockets` in non-existent `bridge-handlers.ts`** | BULLSHIT — `bridge-handlers.ts` does exist. `netSockets` existed in `driver.ts` and was removed by US-023. The AC's file reference was slightly off but the work was done correctly |
| H-15 | **US-026 references `activeChildren` that doesn't exist** | BULLSHIT — `activeChildren` existed and was renamed to `childProcessInstances` by US-026 (confirmed via git diff) |
| H-16 | **US-027 references `_sockets`/`_nextSocketId` that don't exist** | BULLSHIT — both existed as private fields on the WasmVM driver class and were successfully removed by US-027. `_sockets` was replaced with `_tlsSockets` (TLS-only) |

*Root cause: review agents searched the post-implementation codebase without checking git history. The ACs were removal instructions that were successfully executed.*

---

## HIGH Severity — PARTIALLY TRUE

| # | Issue | Nuance |
|---|-------|--------|
| H-9 | **getLocalAddr/getRemoteAddr missing** | No formal methods on SocketTable, but the data is accessible via `socketTable.get(id).localAddr/.remoteAddr`. Node.js bridge tracks these independently. Missing WasmVM `getsockname`/`getpeername` syscalls could be a gap for C programs |
| H-10 | **FD table migration too late** | Ordering discrepancy is real (P22 vs spec step 5), but it caused zero problems because socket IDs and file FDs use separate number spaces. The deeper issue: socket FD / file FD unification was never done at all |

---

## MEDIUM Severity — Validated

| # | Issue | Validated |
|---|-------|-----------|
| M-1 | socketpair split from Unix domain sockets | **BULLSHIT** — socketpair is a self-contained in-memory operation, doesn't need AF_UNIX bind/listen/connect infrastructure |
| M-2 | MSG_NOSIGNAL before signal infrastructure | **BULLSHIT** — test only checks EPIPE return, not SIGPIPE suppression. No signal infrastructure needed |
| M-3 | Network permissions at P11 vs spec step 4 | **BULLSHIT** — caused zero practical problems. Permissions are an optional layer |
| M-4 | N-12 crypto session cleanup omitted | Not validated — likely intentional, low priority per spec |
| M-5 | US-037 assumed conformance runner existed | **CONFIRMED** — agent had to restore deleted infrastructure from git history |
| M-6 | US-037/038 scope enormous | Not validated — agent completed it but was at context limit |
| M-7 | O_NONBLOCK field defined but never enforced | **CONFIRMED** — `nonBlocking` field exists on KernelSocket, initialized to false, but never read in recv/accept/connect |
| M-8 | Port 0 ephemeral port assignment | **PARTIALLY TRUE** — works for external listen (host adapter), but loopback bind to port 0 stays at port 0 and can't be found by `findListener` |
| M-9 | Backlog overflow test missing | **CONFIRMED** — `_backlogSize` parameter is unused (underscore-prefixed), backlog grows unbounded, no test exists |
| M-10 | setsockopt ENOSYS fix for WasmVM | **CONFIRMED** — kernel-worker.ts line 984-987 hardcodes `return ENOSYS`, never routes through kernel SocketTable's working `setsockopt()` |
| M-11 | Pre-existing flaky test failures | Not validated |
| M-12 | Ambiguous file locations in ACs | Not validated — theoretical PRD quality issue |
| M-13 | checkNetworkPermission on SocketTable vs Kernel | **PARTIALLY TRUE** — lives on SocketTable, not Kernel class. Works correctly but AC/spec misleading |

---

## Actionable Issues (filtered to confirmed-real only)

### Must Fix

1. **Complete legacy removal (H-1)** — remove `servers` Map, `ownedServerPorts` Set, `upgradeSockets` Map from driver.ts; remove `activeNetSockets` from bridge/network.ts. These are the ACs of US-023/024/025 that were rationalized away
2. **Build and test WASM binaries (H-2, H-3)** — fix CI crossterm build, compile C programs, run the skip-guarded tests for real
3. **Wire timer/handle to Node.js bridge (H-12)** — kernel TimerTable and handle tracking are dead code. Either wire them into the bridge or remove the dead code
4. **Fix WasmVM setsockopt (M-10)** — route through kernel instead of hardcoding ENOSYS

### Should Fix

5. **Implement SA_RESTART properly (H-4)** — or downgrade the AC to match what was implemented ("define SA_RESTART constant for future use")
6. **Implement O_NONBLOCK enforcement (M-7)** — recv/accept/connect should check `nonBlocking` flag
7. **Implement backlog limit (M-9)** — `listen(fd, backlog)` should cap the backlog queue
8. **Implement loopback port 0 (M-8)** — `bind()` with port 0 should assign ephemeral port for loopback sockets
9. **Add getLocalAddr/getRemoteAddr to SocketTable (H-9)** — formal methods wrapping the property access, plus WasmVM getsockname/getpeername WASI extensions

### Consider

10. **K-9 fs.watch (H-8)** — intentionally deferred but should be documented as such
11. **Socket FD / file FD unification (H-10)** — spec intended shared FD number space but it was never implemented. Sockets use separate IDs

---

## Systemic Findings (confirmed valid)

1. **Skip-guarded tests create false confidence** — Ralph treated "skipped tests don't fail" as "tests pass." Five WasmVM stories passed without any runtime verification. Consider requiring `skipIf` tests to be marked as `vacuous-skip` rather than passing.

2. **Self-audit is structurally weak** — US-039 (the proofing story) was executed by the same agent framework and rationalized unmet ACs. Independent proofing should be done by a human or a separate agent with explicit instructions to fail stories with unmet criteria.

3. **AC dishonesty compounds** — when US-024 kept legacy code instead of removing it (as the AC specified), the debt cascaded: US-025 couldn't remove `ownedServerPorts` because `servers` Map still used it, and US-039 rationalized both. Write ACs that match what's actually achievable, or split removal into a separate story.

4. **progress.txt is load-bearing** — the Codebase Patterns section is what enabled later stories to succeed. This is a strength of the Ralph design.
