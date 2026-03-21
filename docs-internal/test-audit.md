# Test Quality Audit — 2026-03-17

Adversarial review of every test file across all packages. Identifies fake/vacuous tests, weak assertions, dead code, and missing coverage.

---

## FAKE / VACUOUS TESTS (must fix or delete)

Tests that pass regardless of whether the feature works.

### F1. `isolate-runtime-injection-policy.test.ts` — ALL 4 TESTS

**Location:** `packages/secure-exec/tests/isolate-runtime-injection-policy.test.ts`

All 4 tests are source-code grep checks masquerading as security tests. They read `.ts` source files and regex-match for string patterns. Zero behavioral verification — if the injection protection is completely broken but the source contains the expected strings, all tests pass.

- "avoids template-literal isolate eval snippets" — regex on source, not runtime test
- "keeps bridge/require setup loaders on static isolate-runtime sources" — grep for `getIsolateRuntimeSource`
- "browser worker no longer injects fs module code via code strings" — checks absence of `_fsModuleCode` string
- "builds isolate runtime from src/inject entrypoints" — checks build script contents

**Fix:** Delete or replace with behavioral tests that actually run code through the injection boundary and verify safety.

### F2. `driver.test.ts` "accepts custom wasmBinaryPath"

**Location:** `packages/runtime/wasmvm/test/driver.test.ts:172`

Passes a custom path and only asserts `driver.name === 'wasmvm'`. Never verifies the path is stored or used. Would pass if the option is completely ignored.

**Fix:** Pass a bogus path, spawn a command, verify error message references the path.

### F3. `driver.test.ts` "accepts custom memoryLimit" (Node)

**Location:** `packages/runtime/node/test/driver.test.ts:187`

Sets `memoryLimit: 256` then only checks `driver.name === 'node'`. Does not test that memory limit is enforced.

**Fix:** Set low memoryLimit, run code that allocates beyond it, verify OOM kill.

### F4. `driver.test.ts` "accepts custom cpuTimeLimitMs" (Python)

**Location:** `packages/runtime/python/test/driver.test.ts:193`

Sets `cpuTimeLimitMs: 5000` then only checks `driver.name === 'python'`. Does not test enforcement.

**Fix:** Run infinite loop, verify killed within ~5s.

### F5. `driver.test.ts` "WASMVM_COMMANDS is exported and frozen"

**Location:** `packages/runtime/wasmvm/test/driver.test.ts`

Test name says "frozen" but never calls `Object.isFrozen()`. Only checks length and membership.

**Fix:** Add `expect(Object.isFrozen(WASMVM_COMMANDS)).toBe(true)`.

### F6. `driver.test.ts` "proc_spawn routes through kernel.spawn()"

**Location:** `packages/runtime/wasmvm/test/driver.test.ts:344`

Claims to test proc_spawn routing through kernel but just runs `echo hello` and checks stdout. No spy driver, no pipeline, no proof that proc_spawn was involved. Compare to the Node driver test at line 349 which correctly uses a spy driver.

**Fix:** Mount a spy driver for a secondary command, run `echo hello | spycommand`, verify spy received the call.

### F7. `device-layer.test.ts` "/dev/null write is discarded"

**Location:** `packages/kernel/test/device-layer.test.ts`

**No assertion at all.** Calls `writeFile` and does nothing. Would pass even if writes were stored.

**Fix:** Write data, read back `/dev/null`, verify still returns empty.

### F8. `kernel-integration.test.ts` zombie timer disposal tests

**Location:** `packages/kernel/test/kernel-integration.test.ts:1413, 1437`

Both zombie cleanup timer tests have **zero assertions about timer cleanup**. They call `dispose()` and the absence of an exception is treated as success. If every timer leaked, these tests would still pass.

**Fix:** Spy on `clearTimeout` and verify it was called, or verify no pending timers remain after dispose.

### F9. `signal-forwarding.test.ts` "killing a non-existent PID returns ESRCH"

**Location:** `packages/secure-exec/tests/kernel/signal-forwarding.test.ts:86`

Test name says ESRCH but the test just verifies kill-after-exit is a no-op (`.not.toThrow()`). Does not verify ESRCH error code.

**Fix:** Call `kernel.kill(99999, 15)` and verify it throws with code ESRCH.

---

## WEAK TESTS (should strengthen)

Tests that technically assert something but the assertions are too loose to catch real bugs.

### W1. Shape-only driver tests (all 3 runtimes)

Multiple tests only check `typeof driver.init === 'function'` or `toBeDefined()` without calling any method. Found in:
- `node/test/driver.test.ts:166` — "createNodeRuntime returns a RuntimeDriver"
- `python/test/driver.test.ts` — similar shape checks
- `packages/wasmvm/test/driver.test.ts:123` — "createWasmVmRuntime returns a RuntimeDriver"
- `packages/wasmvm/test/driver.test.ts:235` — "spawn returns DriverProcess with correct interface"

**Impact:** Low — TypeScript already catches shape mismatches. Consider deleting or inlining.

### W2. "dispose after init cleans up" (all 3 runtimes)

Calls dispose, asserts nothing about actual cleanup. Found in:
- `node/test/driver.test.ts:208, 330`
- `python/test/driver.test.ts:214, 358`
- `packages/wasmvm/test/driver.test.ts:213, 272`

**Fix:** After dispose, attempt to spawn and verify it throws. Or spy on cleanup internals.

### W3. Resource budget loose assertions

**Location:** `packages/secure-exec/tests/runtime-driver/node/resource-budgets.test.ts`

- "silently drops output bytes beyond the limit" — budget is 100 bytes, asserts `<= 200` (2x slack)
- "applies to stderr as well" — budget is 50 bytes, asserts `<= 100` (2x slack)
- "bridge returns error when budget exceeded" — only asserts `errCount > 0`, not exact count

**Fix:** Tighten to `<= budget + small_overhead` and verify exact error counts.

### W4. Python host filesystem test uses negative-only assertion

**Location:** `packages/runtime/python/test/driver.test.ts:432`

`expect(stdout).not.toContain('SECURITY_BREACH')` — passes if stdout is empty. No positive assertion that `blocked:` appears.

**Fix:** Add `expect(stdout).toContain('blocked:')`.

### W5. Worker adapter exit/error handler tests

**Location:** `packages/runtime/wasmvm/test/worker-adapter.test.ts:190, 210`

Timeout fallback `resolve(new Error('No error received'))` means if the handler never fires, the test still passes because `Error` is still `instanceof Error`.

**Fix:** Use a sentinel value that would fail the subsequent assertion.

### W6. fd-table.test.ts "pre-allocates stdio FDs 0, 1, 2"

**Location:** `packages/kernel/test/fd-table.test.ts`

Only checks `toBeDefined()` for FDs 1 and 2. Doesn't verify they are `FILETYPE_CHARACTER_DEVICE` with correct flags.

**Fix:** Assert filetype and flags for all three stdio FDs.

### W7. "drops high-volume logs" tests (shared suite + index.test.ts)

Multiple tests generate thousands of log lines but only check `code === 0` without verifying any output was actually produced and dropped. Found in:
- `test-suite/node/runtime.ts:74`
- `runtime-driver/node/index.test.ts:217`
- `test-suite/node/runtime.ts:43` ("executes scripts without runtime-managed stdout buffers")

**Fix:** Attach `onStdio` hook, verify some events arrive but count is bounded.

### W8. PTY/shell integration tests use timing-dependent assertions

**Location:** `packages/kernel/test/kernel-integration.test.ts:2418, 2446, 2567`

Use `setTimeout` with small delays (10-20ms) and `toContain` on accumulated output. Fragile and could flake.

**Fix:** Use polling with condition checks instead of fixed-delay assertions.

### W9. Network test uses only `data:` URIs

**Location:** `test-suite/node/network.ts:9`

`fetch('data:text/plain;base64,...')` proves fetch exists but never touches the network. Cannot distinguish a leaky sandbox from a properly isolated one.

**Fix:** Attempt actual network access and verify it's blocked by default.

### W10. "child_process cannot escape to host shell"

**Location:** `packages/secure-exec/tests/kernel/bridge-child-process.test.ts:191`

Runs `echo sandbox-only` and checks output contains "sandbox-only". Would produce identical output on host or in sandbox.

**Fix:** Run a command that produces different output depending on environment (e.g., check for host-only file or env var).

### W11. "pipe read/write FileDescriptions are freed after process exits"

**Location:** `packages/runtime/wasmvm/test/driver.test.ts:394`

Claims to test FD cleanup but just reads a small file and checks exit code. No assertion about FD table state after exit.

**Fix:** Inspect FD table or memory state after process exit.

---

## DEAD CODE / ALWAYS-SKIPPED TESTS

### D1. Browser runtime tests — permanently skipped

**Location:** `packages/secure-exec/tests/runtime-driver/browser/runtime.test.ts`

Entire file behind `describe.skipIf(!IS_BROWSER_ENV)`. In Node CI, every test silently skips. Zero browser coverage actually executes.

**Fix:** Run in vitest browser mode or dedicated browser test runner.

### D2. Shared suite browser target — permanently skipped

**Location:** `packages/secure-exec/tests/test-suite/node.test.ts:103`

The `isTargetAvailable('browser')` check always returns false in Node. The browser half of the shared suite framework is dead code.

### D3. Python integration tests skip when pyodide unavailable

**Location:** `packages/runtime/python/test/driver.test.ts:241-488`

13 integration/security tests behind `skipIf(!pyodideAvailable)`. If pyodide isn't installed, all silently skip.

### D4. Kernel tests skip without WASM binary

**Location:** All 15 files under `packages/secure-exec/tests/kernel/`

All behind `skipUnlessWasmBuilt()`. Documented behavior (CI builds binary), but local dev has zero kernel test coverage.

---

## UNTESTED SOURCE FILES

### U1. `packages/kernel/src/user.ts` — ZERO tests

UserManager class, `getpwuid()`, uid/gid configuration, passwd-format generation — completely untested.

### U2. `packages/runtime/wasmvm/src/kernel-worker.ts` — ZERO direct tests

490 lines of critical code: `rpcCall()`, `createKernelFileIO()`, `createKernelProcessIO()`, `createKernelVfs()`, `createHostProcessImports()` including `proc_spawn`, `proc_waitpid`, `proc_kill`, `fd_pipe`. Only exercised indirectly through skip-gated WASM tests.

### U3. `packages/runtime/wasmvm/src/syscall-rpc.ts` — ZERO direct tests

Entire SharedArrayBuffer RPC protocol (signal buffer layout, data buffer size, syscall IDs, message types). No test verifies the Atomics.wait/notify handshake works.

---

## CRITICAL MISSING COVERAGE

### Security Boundary Tests (HIGH PRIORITY)

| ID | Gap | Description |
|----|-----|-------------|
| M1 | Sandbox escape via Node internals | No test verifies `process.binding()`, `process.dlopen()`, `require('v8').runInDebugContext()` are blocked |
| M2 | Prototype pollution | No test for `Object.prototype.__proto__` manipulation affecting host, or `constructor.constructor('return this')()` eval escape |
| M3 | Global freeze verification | No systematic test that ALL host bridge globals are frozen/non-configurable. Only `_cryptoRandomFill` is tested |
| M4 | Path traversal attacks | No test for `fs.readFileSync("../../../etc/passwd")` or `/proc/self/environ` through base filesystem |
| M5 | Network isolation (Node) | No test attempts real HTTP from sandbox and verifies it's blocked. Only `data:` URIs tested |
| M6 | Env variable leakage (Node) | No test verifies sandboxed code can't see host env vars like `PATH`, `HOME`. Python has this covered |

### Resource Limit Enforcement (HIGH PRIORITY)

| ID | Gap | Description |
|----|-----|-------------|
| M7 | memoryLimit enforcement | Constructor accepts it but no test allocates beyond limit to verify OOM kill |
| M8 | cpuTimeLimitMs enforcement (Node) | Python has timeout recovery test; Node has nothing |
| M9 | timingMitigation | Accepted as option, never tested for effect |
| M10 | FD exhaustion | No test opens thousands of FDs and verifies limit enforcement |
| M11 | Pipe/PTY unbounded buffering | CLAUDE.md flags as critical risk. No test writes large data without reading |

### Integration & Concurrency (MEDIUM PRIORITY)

| ID | Gap | Description |
|----|-----|-------------|
| M12 | Concurrent exec() on same runtime | No test for parallel exec() calls on one RuntimeDriver |
| M13 | Ring buffer cross-thread | All ring buffer tests are single-threaded; the core value prop (blocking cross-thread pipe) is untested |
| M14 | Ring buffer wraparound | No test writes more data than buffer capacity |
| M15 | VFS snapshot/restore | `VFS.snapshot()`, `fromSnapshot()`, `applySnapshot()` have zero tests |
| M16 | Pipe partial read | `drainBuffer` chunk-splitting when reading fewer bytes than available — zero coverage |
| M17 | Concurrent FD operations | No test for concurrent reads/writes on same pipe/PTY from different contexts |
| M18 | Multiple concurrent WASM processes | No test for state leakage between simultaneous WASM processes |

### Error Handling & Cleanup (MEDIUM PRIORITY)

| ID | Gap | Description |
|----|-----|-------------|
| M19 | kill() on DriverProcess | `kill()` exists on every DriverProcess but no test calls it and verifies termination |
| M20 | Bridge callback timeout | No test for when a bridge callback hangs — is there a timeout? |
| M21 | Host error during bridge call | No test for unexpected host errors (EIO) propagating through bridge |
| M22 | Process cleanup on crash | No test verifies workers/isolates/FDs are cleaned up after unexpected crash |
| M23 | Timer cleanup on dispose | No test verifies `setInterval()` handles inside sandbox are cleaned up |
| M24 | Double-dispose for NodeRuntime/PythonRuntime | Kernel tests verify this, standalone runtimes don't |
| M25 | Pipe EOF propagation on WASM exit | No test that piped stdout/stderr FDs close when WASM process exits |
| M26 | waitpid for non-existent PID | Does it throw? Hang? Return immediately? Untested |

### Device Layer (LOW PRIORITY)

| ID | Gap | Description |
|----|-----|-------------|
| M27 | `/dev/stdin`, `/dev/stdout`, `/dev/stderr` read/write | Exist in device paths but behavior never tested |
| M28 | `/dev/zero` write behavior | Not tested |
| M29 | `/dev/urandom` randomness | Only checks non-zero, not that two reads differ |
| M30 | Device rename/link/chmod/truncate | Source handles these but behavior untested |
| M31 | PTY window size storage | `resize()` delivers SIGWINCH but dimensions not verified as stored |

### Permission System (LOW PRIORITY)

| ID | Gap | Description |
|----|-----|-------------|
| M32 | Custom checker returning `{allow: false}` | All tests use missing-checker (deny) or allowAll. No test for explicit deny with reason |
| M33 | Write-side fs permissions | Only readFile/readTextFile tested. writeFile, createDir, removeFile untested |
| M34 | Permission `cwd` parameter | Passed in request but no test verifies checkers can use it |

### Browser (LOW PRIORITY)

| ID | Gap | Description |
|----|-----|-------------|
| M35 | Browser WorkerAdapter | Claims browser support, zero browser test coverage |
| M36 | Browser runtime end-to-end | Entire browser test file is dead code |

---

## RECOMMENDED PRIORITY ORDER

**Phase 1 — Fix fake tests and critical security gaps:**
- Delete/replace F1 (injection policy grep tests)
- Fix F6 (proc_spawn routing), F7 (/dev/null write), F8 (zombie timers), F9 (ESRCH)
- Add M1-M6 (sandbox escape, prototype pollution, path traversal, network isolation, env leakage)
- Add M7-M8 (memoryLimit, cpuTimeLimitMs enforcement)

**Phase 2 — Strengthen weak tests and add resource tests:**
- Fix W3 (resource budget assertions), W4 (negative-only), W7 (high-volume logs)
- Add M11 (unbounded buffering), M12 (concurrent exec), M19 (kill)
- Write tests for U1 (user.ts)

**Phase 3 — Integration and cross-thread tests:**
- Add M13-M14 (ring buffer cross-thread + wraparound)
- Add M15 (VFS snapshot), M16 (pipe partial read)
- Add M18 (concurrent WASM processes)

**Phase 4 — Error handling, cleanup, device layer:**
- Add M20-M26 (bridge timeout, cleanup, EOF propagation)
- Add M27-M31 (device behavior)
- Fix D1-D2 (browser test infrastructure)

---

## STATISTICS

| Category | Count |
|----------|-------|
| Fake/vacuous tests | 9 |
| Weak tests | 11 |
| Dead/always-skipped test files | 4 |
| Untested source files | 3 |
| Missing coverage gaps | 36 |
| Good/strong tests | ~300+ |
