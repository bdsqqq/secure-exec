# glibc portability policy for secure-exec-v8

## Summary

The `secure-exec-v8` binary (Rust + V8 engine) is dynamically linked against glibc.
The minimum glibc version on target systems is determined by two factors:

1. **rusty_v8 prebuilt static libraries** require **glibc >= 2.32** (due to `sem_clockwait` in V8's `sem_waiter.o`)
2. **Rust standard library** links against pthread symbols that were re-versioned in **glibc 2.34** when `libpthread.so` was merged into `libc.so.6`

If we build on a system with glibc >= 2.34, the resulting binary requires glibc >= 2.34 at runtime because all pthread symbols (`pthread_create`, `sem_wait`, `dlsym`, etc.) get stamped with `GLIBC_2.34` version tags.

If we build on a system with glibc 2.32–2.33, pthread symbols resolve against the older separate `libpthread.so` version tags, and the effective floor drops to 2.32 (set by V8).

## Build base image policy

All Linux build environments (Dockerfiles, CI runners) must use **Ubuntu 22.04 (Jammy)** as the base, which ships glibc 2.35. This:

- Satisfies V8's hard floor of glibc 2.32
- Produces binaries compatible with glibc 2.35+ systems
- Covers Ubuntu 22.04+, Debian 12+, Amazon Linux 2023, Fedora 36+, RHEL 9+

Specifically:
- Dockerfiles: `FROM rust:1.85.0-jammy` (not bookworm, not bullseye)
- GitHub Actions: `ubuntu-22.04` (not `ubuntu-latest`, which floats)

## Why not older?

- **Bullseye (glibc 2.31)**: V8's `sem_clockwait` symbol requires 2.32. Linking would fail.
- **CentOS 7 (glibc 2.17)**: Same problem, plus ancient toolchain.

## Why not musl?

The rusty_v8 crate only ships prebuilt `.a` files for `*-linux-gnu` targets. Building V8 from source against musl would require patching V8's build system and takes 30–60 minutes per platform. Not worth it given the glibc 2.35 floor is adequate.

## How to verify

After building, check the binary's glibc floor:

```bash
objdump -T target/release/secure-exec-v8 | grep -oP 'GLIBC_[0-9.]+' | sort -t. -k1,1n -k2,2n -k3,3n -u
```

The highest version in the output is the minimum glibc required at runtime.

## Compatibility matrix

| Distro | glibc | Compatible? |
|---|---|---|
| Ubuntu 20.04 | 2.31 | No |
| Debian 11 (Bullseye) | 2.31 | No |
| Amazon Linux 2 | 2.26 | No |
| Ubuntu 22.04 | 2.35 | Yes |
| Debian 12 (Bookworm) | 2.36 | Yes |
| Amazon Linux 2023 | 2.34 | Yes |
| Ubuntu 24.04 | 2.39 | Yes |
| Fedora 36+ | 2.35+ | Yes |
| RHEL 9 | 2.34 | Yes |
