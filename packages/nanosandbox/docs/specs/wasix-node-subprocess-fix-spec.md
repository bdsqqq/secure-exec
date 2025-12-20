# WASIX Node Subprocess Fix Specification

## Problem Summary

Sandboxed Node.js code needs to spawn child processes (e.g., `child_process.spawnSync('echo', ['hello'])`). These child processes should run natively within WASIX, not be delegated back to the host via `host_exec`.

## Current Blocker

**wasmer-js is missing WASIX syscalls required for subprocess spawning.**

The WASIX toolchain (`cargo wasix build`) generates WASM that imports these syscalls:
- `proc_spawn2` - spawn a new process
- `fd_dup2` - duplicate file descriptor to specific fd
- `path_open2` - open path with extended options
- `fd_fdflags_get` - get file descriptor flags
- `fd_fdflags_set` - set file descriptor flags
- `proc_exec3` - exec replacement
- `proc_signals_get/sizes_get` - signal handling
- `sock_pair` - socket pairs
- `dl*` - dynamic loading functions
- `closure_*` - closure support
- `reflect_signature` - reflection

These syscalls exist in **upstream wasmer** but are missing from the **wasmer-js fork** which is ~18,000 commits behind.

## Evidence

### Native wasmer CLI works:
```bash
cd /home/nathan/misc/wasix-cp-test
wasmer run wasix-spawn.webc --env PATH=/bin
# Output: Successfully spawns ls, shows directory listing
```

### wasmer-js fails:
```
WARN wasmer::js::module: import not found wasix_32v1:proc_spawn2
WARN wasmer::js::module: import not found wasix_32v1:fd_dup2
ERROR wasmer_js::tasks::task_wasm: Failed to create wasi context
```

## Architecture (When Fixed)

```
1. Host spawns WASIX "node" command
2. wasix-runtime calls host_exec_start
3. Host runs sandboxed-node (V8 isolate)
4. Sandboxed-node calls spawn('echo', ['hello'])
5. spawnChildStreaming sends SPAWN_REQUEST to wasix-runtime
6. wasix-runtime spawns child NATIVELY via Command::new()  <-- BLOCKED
7. wasix-runtime sends output via host_exec_child_output
8. Callbacks in CHILD_OUTPUT_HANDLERS receive stdout/stderr/exit
9. Sandboxed-node receives output
```

## Implementation Details

### WASIX libc PATH Issue

WASIX libc's `posix_spawn` does NOT search `$PATH`. Commands must be resolved to absolute paths before spawning.

**Solution:** Use the `which` crate to resolve commands:
```rust
// In wasix-runtime/src/main.rs
std::env::set_var("PATH", "/bin");

let command_path = match which::which(&command) {
    Ok(path) => path,
    Err(_) => return Err("command not found"),
};

Command::new(&command_path).args(&args).spawn()
```

### Current Code State

The wasix-runtime is already prepared:
- `Cargo.toml` includes `which = "7"`
- `handle_spawn_request()` uses `which::which()` to resolve commands
- `check_child_processes()` forwards stdout/stderr/exit via `host_exec_child_output`

But it's built with `wasm32-wasip1` which doesn't support `Command::new()`.

## Fix Steps

### 1. Upgrade wasmer-js to wasmer 0.10+

The wasmer-js repo at `/home/nathan/misc/wasmer-js` uses:
```toml
wasmer-wasix = { path = "../wasmer/lib/wasix" }
```

The local wasmer fork at `/home/nathan/misc/wasmer` is missing the new syscalls.

**Option A:** Merge upstream wasmer into the fork
```bash
cd /home/nathan/misc/wasmer
git fetch upstream
git merge upstream/main  # Will have conflicts
```

**Option B:** Cherry-pick specific syscall implementations from upstream:
- `lib/wasix/src/syscalls/wasix/proc_spawn2.rs`
- `lib/wasix/src/syscalls/wasix/fd_dup2.rs`
- `lib/wasix/src/syscalls/wasix/path_open2.rs`
- `lib/wasix/src/syscalls/wasix/fd_fdflags_get.rs`
- `lib/wasix/src/syscalls/wasix/fd_fdflags_set.rs`
- Update `lib/wasix/src/syscalls/wasix/mod.rs`
- Update `lib/wasix/src/lib.rs` to register syscalls

### 2. Rebuild wasmer-js

```bash
cd /home/nathan/misc/wasmer-js
cargo build --release
pnpm build  # or however the JS package is built
```

### 3. Update wasix-runtime build

```bash
# In packages/nanosandbox/wasix-runtime/build.sh
cargo wasix build --release  # Instead of cargo build --target wasm32-wasip1
```

```toml
# In packages/nanosandbox/wasix-runtime/wasmer.toml
[[module]]
source = "target/wasm32-wasmer-wasi/release/wasix-runtime.wasm"  # Updated path
```

### 4. Test

```bash
cd /home/nathan/lightweight-sandbox/packages/nanosandbox
pnpm exec vitest run tests/node-child-process.test.ts
```

## Files Modified

| File | Change |
|------|--------|
| `wasix-runtime/Cargo.toml` | Added `which = "7"` dependency |
| `wasix-runtime/src/main.rs` | Refactored `handle_spawn_request` to use `Command::new()` with PATH resolution |
| `wasix-runtime/build.sh` | Currently wasm32-wasip1, needs switch to `cargo wasix` |
| `wasix-runtime/wasmer.toml` | Currently wasm32-wasip1 path, needs update |
| `src/vm/index.ts` | Removed `handleShellCommand` (children spawn in WASIX) |

## Working Example

A working example exists at `/home/nathan/misc/wasix-cp-test` that demonstrates:
1. Using `which` crate to resolve commands
2. Calling `posix_spawn` directly via FFI
3. Waiting for child with `waitpid`

This works with native `wasmer run` but not wasmer-js due to missing syscalls.

## References

- WASIX spawn tutorial: https://wasix.org/docs/language-guide/rust/tutorials/wasix-spawn
- wasix-rust-examples: https://github.com/wasix-org/wasix-rust-examples/tree/main/wasix-spawn
- Upstream wasmer syscalls: `git show upstream/main:lib/wasix/src/lib.rs`
