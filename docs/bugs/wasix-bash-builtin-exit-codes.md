# WASIX posix_spawnp PATH Resolution Bug

## Summary

WASIX's `posix_spawnp()` does not correctly search `$PATH` for commands. This causes commands spawned by relative name to fail with exit code 45 (ENOEXEC).

## Affected

- All WASIX programs using `posix_spawnp()` or Rust's `Command::new()` with relative command names
- Affects: `sh -c`, `child_process.spawn()`, any subprocess spawning by name

## Symptoms

```bash
# Relative commands - fail with exit code 45
sh -c "echo hello"        # stdout: hello, exit: 45 ✗
sh -c "ls /"              # may fail depending on shell lookup

# Absolute paths - work correctly
sh -c "/bin/echo hello"   # stdout: hello, exit: 0 ✓
sh -c "/bin/ls /"         # stdout: bin..., exit: 0 ✓
```

In Node.js child_process:
```js
spawnSync('echo', ['hello'])      // fails without PATH resolution
spawnSync('/bin/echo', ['hello']) // works with absolute path
```

## Exit Code 45 Meaning

In WASIX errno definitions, 45 = `ENOEXEC` ("Executable file format error").

See: https://wasmerio.github.io/wasmer/crates/doc/wasmer_wasix_types/wasi/bindings/enum.Errno.html

## Root Cause

The bug is in wasmer's `proc_spawn2` syscall implementation. The PATH resolution logic exists but doesn't work correctly.

### Code Flow

1. `Command::new("echo")` → `posix_spawnp("echo", ...)`
2. `posix_spawnp` → `__posix_spawn(..., use_path=1)`
3. `__posix_spawn` → `__wasi_proc_spawn2(..., use_path=true, getenv("PATH"))`
4. wasmer's `proc_spawn2` → `find_executable_in_path()` → **FAILS**

### Relevant Files

- `wasix-libc`: `libc-top-half/musl/src/process/posix_spawnp.c`
- `wasix-libc`: `libc-top-half/musl/src/process/posix_spawn.c` (calls proc_spawn2)
- `wasmer`: `lib/wasix/src/syscalls/wasix/proc_spawn2.rs`
- `wasmer`: `lib/wasix/src/syscalls/wasix/proc_exec3.rs` (find_executable_in_path)

## Current Workaround

In `wasix-runtime/src/main.rs`, we use the `which` crate to resolve commands to absolute paths before spawning:

```rust
let command_path = if spawn_req.command.starts_with('/') {
    std::path::PathBuf::from(&spawn_req.command)
} else {
    match which::which(&spawn_req.command) {
        Ok(path) => path,
        Err(e) => { /* return error */ }
    }
};
```

## Impact on nanosandbox

- `child_process.spawn()` works because wasix-runtime's `which` hack resolves paths
- `child_process.exec()` uses `sh -c` internally, which may have issues
- Workaround: Use `spawn()` with direct commands, or use absolute paths

## Status

- **Open** - Bug is in wasmer's `proc_spawn2` PATH resolution
- Workaround: `which` hack in wasix-runtime
- See: `docs/specs/WASIX_LIBC_PATH_FIX.md` for investigation details
