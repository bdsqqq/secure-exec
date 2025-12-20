# WASIX PATH Resolution Fix Specification

## Overview

Fix the `posix_spawnp()` PATH resolution bug that causes commands spawned by relative name to fail with ENOEXEC (45) or "Spawn failed".

## Bug Summary

**Status**: CONFIRMED - Bug is in wasmer's `find_executable_in_path` function.

| Spawn Method | Result |
|--------------|--------|
| `Command::new("/bin/echo")` | ✅ Works |
| `Command::new("echo")` with `which` hack | ✅ Works (resolves to `/bin/echo` first) |
| `Command::new("echo")` without `which` hack | ❌ Fails - "Spawn failed" |

**Key Finding**: The file `/bin/echo` exists and is accessible (verified via `std::fs::metadata`), but wasmer's PATH resolution fails to find it.

## Test Evidence

```
[wasix-shim] PATH env: Ok("/bin")
[wasix-shim] /bin contents: ["arch", "base32", "base64", "baseenc", "basename", "cat", ...]
[wasix-shim] /bin/echo exists, is_file=true
[wasix-shim] Failed to spawn child 1 (echo): Spawn failed (kind: Other)
```

With absolute path:
```
[wasix-shim] Command is absolute: /bin/echo
[wasix-shim] Child 2 spawned successfully
[wasix-shim] Child 2 exited with code 0
```

## Code Flow Analysis

### wasix-libc correctly passes use_path to syscalls

#### posix_spawnp (libc-top-half/musl/src/process/posix_spawnp.c)

```c
int posix_spawnp(...) {
    // WASIX: delegates to syscall with use_path=1
    return __posix_spawn(res, file, fa, attr, argv, envp, 1);
}
```

#### __posix_spawn calls proc_spawn2 (libc-top-half/musl/src/process/posix_spawn.c:447-449)

```c
int err = __wasi_proc_spawn2(
    path, combined_argv, combined_env, fdops, nfdops, signals, nsignals,
    use_path ? __WASI_BOOL_TRUE : __WASI_BOOL_FALSE, getenv("PATH"), &ret_pid);
```

### Syscall Summary

| libc function | syscall | use_path | searches PATH? |
|---------------|---------|----------|----------------|
| `posix_spawn` | `proc_spawn2` | false | no |
| `posix_spawnp` | `proc_spawn2` | **true** | should, but broken |
| `execv/execve` | `proc_exec3` | false | no |
| `execvp/execlp` | `proc_exec3` | **true** | should, but likely broken |

### The Bug is in Wasmer's proc_spawn2

#### proc_spawn2.rs (lib/wasix/src/syscalls/wasix/proc_spawn2.rs)

```rust
if search_path == Bool::True && !name.contains('/') {
    let path = if path.is_null() {
        vec!["/usr/local/bin", "/bin", "/usr/bin"]
    } else {
        path_str = unsafe { get_input_str_ok!(&memory, path, path_len) };
        path_str.split(':').collect()
    };
    let (_, state, inodes) =
        unsafe { ctx.data().get_memory_and_wasi_state_and_inodes(&ctx, 0) };
    match find_executable_in_path(&state.fs, inodes, path.iter().map(AsRef::as_ref), &name) {
        FindExecutableResult::Found(p) => name = p,
        FindExecutableResult::AccessError => return Ok(Errno::Access),
        FindExecutableResult::NotFound => return Ok(Errno::Noexec),  // <-- BUG: Returns 45
    }
}
```

#### find_executable_in_path (lib/wasix/src/syscalls/wasix/proc_exec3.rs)

```rust
pub(crate) fn find_executable_in_path<'a>(
    fs: &WasiFs,
    inodes: &WasiInodes,
    path: impl IntoIterator<Item = &'a str>,
    file_name: &str,
) -> FindExecutableResult {
    for p in path {
        let full_path = format!("{}/{}", p.trim_end_matches('/'), file_name);
        match fs.get_inode_at_path(inodes, VIRTUAL_ROOT_FD, &full_path, true) {
            Ok(_) => return FindExecutableResult::Found(full_path),
            Err(Errno::Access) => encountered_eaccess = true,
            Err(_) => (),  // <-- Silently swallows errors, returns NotFound
        }
    }
    FindExecutableResult::NotFound
}
```

## Root Cause Hypothesis

The `fs.get_inode_at_path()` call in `find_executable_in_path` is failing even though the file exists. Possible causes:

1. **wasmer-js filesystem isolation**: The spawned child context may have different filesystem mounts
2. **Inode lookup differs from file access**: `get_inode_at_path` checks existence differently than `std::fs::metadata`
3. **PATH string not being passed correctly**: `getenv("PATH")` in libc might return NULL in WASIX context

## Current Workaround

In `wasix-runtime/src/main.rs`, we use the `which` crate to resolve commands:

```rust
let command_path = if spawn_req.command.starts_with('/') {
    std::path::PathBuf::from(&spawn_req.command)
} else {
    which::which(&spawn_req.command)?  // Resolves "echo" → "/bin/echo"
};
```

This works because `which` uses `std::fs` to search PATH, which correctly finds `/bin/echo`.

## Test Files

- `packages/nanosandbox/tests/path-resolution.test.ts` - Tests for PATH resolution with/without `which` hack
- Use `nowhich:` prefix on command to bypass `which` hack for testing

## Related Files

| File | Purpose |
|------|---------|
| `~/misc/wasix-libc/libc-top-half/musl/src/process/posix_spawnp.c` | libc posix_spawnp |
| `~/misc/wasix-libc/libc-top-half/musl/src/process/posix_spawn.c` | libc posix_spawn, calls proc_spawn2 |
| `~/misc/wasmer/lib/wasix/src/syscalls/wasix/proc_spawn2.rs` | Wasmer proc_spawn2 syscall |
| `~/misc/wasmer/lib/wasix/src/syscalls/wasix/proc_exec3.rs` | find_executable_in_path |
| `packages/nanosandbox/wasix-runtime/src/main.rs` | Current `which` workaround |

## Next Steps

1. **Add tracing to wasmer's find_executable_in_path** - Use `tracing` crate instead of `eprintln!`
2. **Debug fs.get_inode_at_path** - Understand why it fails when `std::fs::metadata` succeeds
3. **Check PATH parameter passing** - Verify the PATH string reaches proc_spawn2 correctly
4. **Fix in wasmer or document permanent workaround**

## References

- POSIX posix_spawn: https://man7.org/linux/man-pages/man3/posix_spawn.3.html
- WASIX errno definitions: https://wasmerio.github.io/wasmer/crates/doc/wasmer_wasix_types/wasi/bindings/enum.Errno.html
- wasix-libc fork: https://github.com/NathanFlurry/wasix-libc
- wasmer repo: https://github.com/wasmerio/wasmer
