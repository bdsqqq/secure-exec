# Wasmer PATH Resolution Fix

## Problem Statement

When a WASIX program calls `posix_spawnp("echo", ...)` or `Command::new("echo")`, the spawn fails with "Spawn failed" even though `/bin/echo` exists and is accessible via `std::fs::metadata()`.

### Evidence

```
[wasix-shim] PATH env: Ok("/bin")
[wasix-shim] /bin/echo exists, is_file=true     # std::fs works!
[wasix-shim] Failed to spawn child 1 (echo): Spawn failed
```

But with absolute path:
```
[wasix-shim] Command is absolute: /bin/echo
[wasix-shim] Child 2 spawned successfully       # Works!
```

## Root Cause Analysis

### Code Flow

1. `Command::new("echo").spawn()` calls `posix_spawnp("echo", ...)`
2. wasix-libc's `posix_spawnp` calls `__wasi_proc_spawn2(..., use_path=true, PATH="/bin")`
3. wasmer's `proc_spawn2` syscall calls `find_executable_in_path()`
4. `find_executable_in_path` uses `fs.get_inode_at_path(inodes, VIRTUAL_ROOT_FD, "/bin/echo", true)`
5. This returns `Err` → returns `Errno::Noexec` (45)

### The Issue

`fs.get_inode_at_path()` fails where `std::fs::metadata()` succeeds. They use different code paths:

- `std::fs::metadata("/bin/echo")` → wasix-libc → `path_filestat_get` syscall
- `fs.get_inode_at_path(...)` → internal wasmer API → `get_inode_at_path_inner`

The `get_inode_at_path_inner` function:
1. Walks path components from root_inode
2. For each component, checks the `entries` HashMap cache
3. If not cached, uses `root_fs.symlink_metadata(&file)` to check existence

The failure occurs because either:
1. The `entries` cache doesn't contain the executable
2. The `root_fs` filesystem doesn't see the file
3. The path resolution differs from the syscall path

## Implementation Plan

### Phase 1: Add Debug Tracing

Add tracing to `find_executable_in_path` and `get_inode_at_path_inner`:

```rust
// In find_executable_in_path
pub(crate) fn find_executable_in_path<'a>(
    fs: &WasiFs,
    inodes: &WasiInodes,
    path: impl IntoIterator<Item = &'a str>,
    file_name: &str,
) -> FindExecutableResult {
    tracing::debug!(file_name = %file_name, "find_executable_in_path: searching PATH");

    for p in path {
        let full_path = format!("{}/{}", p.trim_end_matches('/'), file_name);
        tracing::debug!(full_path = %full_path, "find_executable_in_path: checking path");

        match fs.get_inode_at_path(inodes, VIRTUAL_ROOT_FD, &full_path, true) {
            Ok(_) => {
                tracing::debug!(full_path = %full_path, "find_executable_in_path: FOUND");
                return FindExecutableResult::Found(full_path);
            }
            Err(e) => {
                tracing::debug!(full_path = %full_path, error = ?e, "find_executable_in_path: not found");
            }
        }
    }
    FindExecutableResult::NotFound
}
```

### Phase 2: Identify Root Cause

Once tracing is added, the logs will show:
- Which PATH entries are being checked
- What error `get_inode_at_path` returns
- Whether the issue is in path resolution or filesystem access

### Phase 3: Implement Fix

Based on the root cause, potential fixes:

**Option A: Fix filesystem lookup**
If `root_fs.symlink_metadata()` is failing, ensure the filesystem is properly mounted.

**Option B: Use alternate lookup method**
Instead of `get_inode_at_path`, use a method that matches `std::fs::metadata`:
```rust
// Alternative: use the same path resolution as syscalls
match fs.root_fs.metadata(Path::new(&full_path)) {
    Ok(_) => return FindExecutableResult::Found(full_path),
    Err(_) => continue,
}
```

**Option C: Fix inode caching**
If the issue is stale inode caching, clear/refresh the cache.

## Files to Modify

| File | Change |
|------|--------|
| `lib/wasix/src/syscalls/wasix/proc_exec3.rs` | Add tracing to `find_executable_in_path` |
| `lib/wasix/src/fs/mod.rs` | Add tracing to `get_inode_at_path_inner` |

## Testing

1. Rebuild wasmer-js with changes
2. Run `tests/path-resolution.test.ts` with `nowhich:` prefix
3. Check logs for path resolution details
4. Verify fix allows relative path spawning

## Success Criteria

- `Command::new("echo").spawn()` succeeds without the `which` hack
- PATH resolution matches behavior of `std::fs::metadata()`
- All existing tests continue to pass

---

## Investigation Findings (2024-12-20)

### Finding 1: Coreutils `sh` is NOT a real shell

The `sharrattj/coreutils` package's `sh` command is a **multi-call binary** (like busybox), not a real Bourne shell.

```
$ wasmer run sharrattj/coreutils --command sh -- --help
sh 0.0.7 (multi-call binary)
Usage: sh [function [arguments...]]

Currently defined functions:
    arch, base32, base64, basename, cat, cksum, ...
```

When you run `sh -c "echo hello"`, the `-c` is interpreted as a function name to look up, NOT as a shell flag. This causes the error:
```
-c: function/utility not found
```

**Solution**: Use `wasmer/bash` for testing real shell functionality.

### Finding 2: Debug tracing IS working

The tracing added to `get_inode_at_path_inner` appears in the logs:
```
DEBUG wasmer_wasix::fs: get_inode_at_path_inner: symlink_metadata failed file=/usr/local error=EntryNotFound
DEBUG wasmer_wasix::fs: get_inode_at_path_inner: symlink_metadata failed file=/usr/sbin error=EntryNotFound
```

Many directories in the PATH don't exist: `/usr/local`, `/usr/sbin`, `/sbin`. However, `/bin/echo` IS properly injected:
```
DEBUG wasmer_wasix::state::env: Injected a command into the filesystem package=wasmer/bash@1.0.24 command_name="echo" path=/bin/echo
```

### Finding 3: Wasmer-JS subprocess spawning is BLOCKED by setTimeout bug

When trying to run external commands from bash (e.g., `bash -c "/bin/echo hello"`), the test times out with a panic:

```
panicked at src/utils.rs:57:22:
called `Result::unwrap()` on an `Err` value: JsValue(Error: expected a number argument, found object
```

The issue is in `wasmer-js/src/utils.rs`:
```rust
pub fn sleep(&self, milliseconds: i32) -> Promise {
    Promise::new(&mut |resolve, reject| match self {
        GlobalScope::Worker(worker_global_scope) => {
            worker_global_scope
                .set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, milliseconds)
                .unwrap();  // <-- Panics here!
        }
        // ...
    })
}
```

In Node.js worker threads, the `setTimeout` binding via `web_sys` doesn't work correctly - it receives an object where it expects a number. This blocks the scheduler and causes subprocess spawning to hang indefinitely.

**Symptoms**:
- Bash builtins work fine: `bash -c "echo hello"` passes
- Any external command hangs: `bash -c "/bin/echo hello"` times out
- The fork/exec sequence starts but blocks waiting on the scheduler

### Finding 4: Tests that work vs. fail

| Test | Result | Notes |
|------|--------|-------|
| `bash --version` | ✅ Pass | No subprocess |
| `bash -c "echo hello"` | ✅ Pass | Uses builtin |
| `bash -c "$PATH"` | ✅ Pass | Variable expansion, no subprocess |
| `bash -c "/bin/echo hello"` | ❌ Timeout | Subprocess spawn blocked |
| `bash -c "command echo"` | ❌ Timeout | Forces external, spawn blocked |
| `bash -c "ls /"` | ❌ Timeout | ls is external, spawn blocked |

### Blocking Issue

The wasmer-js setTimeout bug must be fixed before the PATH resolution bug can be properly tested. Without working subprocess spawning, we cannot verify if the PATH resolution fix works.

**Options**:
1. Fix the setTimeout bug in wasmer-js (complex - Node.js worker thread compatibility)
2. Test PATH resolution using a different approach (e.g., Rust unit tests)
3. Add a mock/polyfill for setTimeout in Node.js worker context

---

## Major Finding: PATH Resolution Works in Native Wasmer (2024-12-20)

### Native Wasmer Test Results

Created a Rust test program at `~/misc/wasix-cp-test` that directly tests `posix_spawnp`:

```rust
extern "C" {
    fn posix_spawnp(pid: *mut i32, file: *const i8, ...);
}

fn test_spawnp(cmd: &str, args: &[&str]) {
    let result = unsafe { posix_spawnp(&mut pid, cmd_cstr.as_ptr(), ...) };
    // ...
}
```

**All tests PASSED with native wasmer CLI:**

```
$ wasmer run . --command test-posix-spawnp --env PATH=/bin

=== Testing posix_spawnp PATH resolution ===

--- Test 1: posix_spawnp("echo") ---
SUCCESS: Spawned with PID: 2
hello from posix_spawnp

--- Test 2: posix_spawnp("ls") ---
SUCCESS: Spawned with PID: 3
bin dev etc tmp usr

--- Test 3: posix_spawnp("/bin/echo") - absolute path ---
SUCCESS: Spawned with PID: 4
hello with absolute path
```

### Conclusion: The Bug is Wasmer-JS Specific

The PATH resolution works correctly in native wasmer. The bug is somewhere in the wasmer-js integration layer:

1. **Native wasmer CLI** (Rust) → `posix_spawnp` → `proc_spawn2` → ✅ Works
2. **Wasmer-JS** (WASM in Node.js) → Same code path → ❌ Fails

### setTimeout Bug Fix

Fixed the Node.js setTimeout compatibility issue in wasmer-js:

**Before (broken in Node.js):**
```javascript
const ret = arg0.setTimeout(arg1, arg2);
_assertNum(ret);  // Fails: Node.js returns Timeout object
return ret;
```

**After (works in Node.js):**
```javascript
const ret = arg0.setTimeout(arg1, arg2);
// Node.js returns Timeout object, browser returns number. Coerce to number.
const retNum = typeof ret === 'number' ? ret :
    (ret[Symbol.toPrimitive] ? ret[Symbol.toPrimitive]('number') : 0);
_assertNum(retNum);
return retNum;
```

This fix is applied to `wasmer-js/dist/index.mjs` lines 3201-3214.

### Remaining Issues

After the setTimeout fix, subprocess spawning partially works:

| Command | Result | Notes |
|---------|--------|-------|
| `spawnSync('ls', [...])` with which hack | ✅ Works | Absolute path used |
| `spawnSync('echo', [...])` with which hack | ✅ Works | Absolute path used |
| `spawnSync('sh', ['-c', ...])` | ❌ Exits code 1 | coreutils sh is multi-call binary |
| `spawnSync('nowhich:echo', [...])` | ❌ Hangs | PATH resolution path |
| `spawnSync('nowhich:/bin/echo', [...])` | ⚠️ Completes code 0 but times out | IPC delivery issue |

The last test shows the spawn actually succeeds (exit code 0) but the result isn't delivered back to the waiting spawnSync. This is an IPC/callback delivery issue in the wasix-runtime or sandboxed-node integration.

### Next Steps

1. ✅ PATH resolution is confirmed working in native wasmer
2. ✅ setTimeout bug is fixed
3. 🔄 Need to debug why child spawn results aren't delivered to spawnSync
4. Consider if the nanosandbox architecture needs redesign for subprocess support

---

## Definitive Test: Bash + Coreutils via Native Wasmer CLI

Created a comprehensive test at `~/misc/wasmer-bash-test/` that runs the same tests as the wasmer-js tests, but using the native wasmer CLI.

### Test Results: ALL PASS

```
=== Wasmer Bash + Coreutils Test ===

--- Test 1: bash --version ---
stdout: GNU bash, version dist.16(1) (wasm32-wasmer-wasi)
exit code: Some(0)

--- Test 2: bash -c 'echo hello' (builtin) ---
stdout: hello from bash builtin
exit code: Some(0)

--- Test 3: bash -c 'echo $PATH' ---
stdout: PATH=/bin:/usr/bin
exit code: Some(0)

--- Test 4: bash -c '/bin/echo hello' (absolute path) ---
stdout: hello from external echo
exit code: Some(0)

--- Test 5: bash -c 'command echo hello' (via PATH) ---
stdout: echo
hello via PATH
exit code: Some(0)

--- Test 6: bash -c 'ls /' (via PATH) ---
stdout: bin dev etc tmp usr
exit code: Some(0)

--- Test 7: bash -c 'ls /bin' ---
stdout: arch base32 base64 ... (20+ commands)
exit code: Some(0)

--- Test 8: Run subprocess with output capture ---
stdout: captured: captured
exit code: Some(0)
```

### Key Findings

| Test | Wasmer-JS | Native Wasmer | Notes |
|------|-----------|---------------|-------|
| bash --version | ✅ | ✅ | No subprocess |
| echo (builtin) | ✅ | ✅ | No subprocess |
| /bin/echo (absolute) | ❌ Timeout | ✅ | Subprocess fails in JS |
| command echo (PATH) | ❌ Timeout | ✅ | PATH resolution works natively |
| ls / | ❌ Timeout | ✅ | Subprocess works natively |
| $() capture | N/A | ✅ | Subprocess capture works |

### Conclusion

**The PATH resolution and subprocess spawning bugs are 100% wasmer-js specific.**

The native wasmer runtime (Rust) correctly:
1. Resolves commands via PATH using `find_executable_in_path`
2. Spawns subprocesses via `posix_spawnp` / `proc_spawn2`
3. Captures subprocess output via `$()` substitution

The wasmer-js integration has issues with:
1. ~~setTimeout incompatibility with Node.js~~ (fixed)
2. Child process result delivery to waiting spawnSync
3. ~~Possibly the scheduler/threading model in WASM environment~~ (root cause identified below)

The `which` hack workaround in nanosandbox is the correct approach until wasmer-js is fixed.

---

## Definitive Root Cause Analysis (2024-12-20)

### The Problem

WASM subprocess spawning fails in wasmer-js because **`virtual_fs::Pipe` uses tokio channels which cannot work across Web Workers**.

### Technical Details

**Native Wasmer (works):**
- Subprocesses run in real OS threads
- Threads share the same memory space
- `tokio::sync::mpsc` channels work via shared memory pointers
- Parent and child can communicate via inherited pipe file descriptors

**Wasmer-JS (fails):**
- Subprocesses run in separate Web Workers
- Web Workers have **isolated memory spaces**
- `tokio::sync::mpsc` channels are **copied, not shared** when spawning a Worker
- The copied channels point to different memory - writes never reach the reader

### Code Analysis

In `lib/virtual-fs/src/pipe.rs`:
```rust
pub struct Pipe {
    send: PipeTx,
    recv: PipeRx,
}

pub struct PipeTx {
    tx: Option<mpsc::UnboundedSender<Vec<u8>>>,  // ← tokio channel
    rx_end: Weak<Mutex<PipeReceiver>>,
}
```

When `proc_spawn2` spawns a child:
1. The child's `WasiEnv` is serialized and sent to a new Web Worker
2. The `Pipe` is cloned/copied during this process
3. The tokio channel `mpsc::UnboundedSender` becomes **disconnected** from the original receiver
4. Child writes to stdout → goes to a dead channel → parent never receives

### Why This Manifests as Hangs

1. Parent process waits for child output via `waitpid` equivalent
2. Child runs and exits normally (hence "exit code 0" in logs)
3. But child's stdout/stderr data never reaches parent
4. Parent blocks forever waiting for data that will never arrive

### Potential Fixes

The fix must be in wasmer-js, not wasmer core. Options:

1. **SharedArrayBuffer-based Pipes**: Replace tokio channels with SharedArrayBuffer + Atomics for cross-Worker communication (complex but performant)

2. **Route via Scheduler**: All subprocess stdio flows through the main thread scheduler using postMessage (simpler but adds latency)

3. **Disable WASM Subprocesses**: Document that WASM-to-WASM spawning isn't supported; only host_exec for real processes

### Current Workaround

The nanosandbox `which` hack remains the correct approach:
- Resolve command paths before spawning
- Use host_exec for process spawning (routes through Node.js)
- Avoid relying on WASIX's posix_spawnp PATH resolution

### Files Involved

| File | Role |
|------|------|
| `lib/virtual-fs/src/pipe.rs` | Pipe implementation using tokio channels |
| `lib/wasix/src/syscalls/wasix/proc_spawn2.rs` | Subprocess spawning syscall |
| `lib/wasix/src/bin_factory/exec.rs` | WASM task spawning via `task_wasm()` |
| `wasmer-js/src/tasks/task_wasm.rs` | Worker-based WASM task execution |
| `wasmer-js/src/tasks/worker_handle.rs` | Web Worker management |
