# uutils pwd fails on WASI

## Symptom

```
pwd: failed to get current directory: Operation not supported on this platform
```

## Root Cause

The uutils `pwd` implementation calls `path.canonicalize()` on non-unix targets:

```rust
#[cfg(unix)]
{
    Ok(path)
}

#[cfg(not(unix))]
{
    path.canonicalize()  // panics on WASI
}
```

WASI is not considered `unix` by Rust's cfg, so it takes the non-unix path and `canonicalize()` panics on WASI.

## Fix

Our patched `nathanflurry/coreutils` adds `target_os = "wasi"` to skip `canonicalize()`:

```rust
#[cfg(any(unix, target_os = "wasi"))]
{
    Ok(path)
}
```

In `wasix-runtime/wasmer.toml`:
```toml
[dependencies]
"nathanflurry/coreutils" = "0.1.0"
```

## Rebuilding

```bash
cd ~/misc/wasix-builds/builds/coreutils
make distclean && make build
cd output && wasmer publish
```

Patches applied:
- `patches/pwd-wasi.patch` - Adds WASI cfg conditions
- `patches/cargo-getrandom.patch` - Forces getrandom 0.2.x (0.3.x has strict WASI detection)
