# node-permissions Specification

## Purpose
Define deny-by-default permission behavior and permission helper contracts for secure-exec runtime execution.
## Requirements
### Requirement: Deny operations when no permission checker is provided
The system SHALL deny (throw `EACCES`) any filesystem, network, child-process, or environment-variable operation when the corresponding `PermissionCheck` callback is `undefined` in the `Permissions` object.

#### Scenario: Filesystem read without fs permission checker
- **WHEN** a sandboxed module calls `fs.readFile("/some/path")` and no `permissions.fs` callback is provided
- **THEN** the operation SHALL throw an `EACCES` error with syscall `open` and the requested path

#### Scenario: Network fetch without network permission checker
- **WHEN** a sandboxed module calls `fetch("https://example.com")` and no `permissions.network` callback is provided
- **THEN** the operation SHALL throw an `EACCES` error with syscall `connect` and the requested URL

#### Scenario: Child process spawn without childProcess permission checker
- **WHEN** a sandboxed module calls `child_process.spawn("ls", ["-la"])` and no `permissions.childProcess` callback is provided
- **THEN** the operation SHALL throw an `EACCES` error with syscall `spawn` and the command name

#### Scenario: Environment variable read without env permission checker
- **WHEN** a sandboxed module accesses `process.env.SECRET_KEY` and no `permissions.env` callback is provided
- **THEN** the access SHALL throw an `EACCES` error with syscall `access` and the key name

### Requirement: filterEnv returns empty object when no checker is provided
The `filterEnv` function SHALL return an empty object `{}` when no `permissions.env` callback is provided, preventing any host environment variables from leaking into the sandbox.

#### Scenario: filterEnv with no env permission checker
- **WHEN** `filterEnv` is called with a populated `env` record and `permissions.env` is `undefined`
- **THEN** the result SHALL be an empty object `{}`

#### Scenario: filterEnv with explicit allow-all env permission checker
- **WHEN** `filterEnv` is called with a populated `env` record and `permissions.env` returns `{ allow: true }` for all keys
- **THEN** the result SHALL contain all entries from the input `env` record

### Requirement: allowAll permission helper
The system SHALL export an `allowAll` constant of type `Permissions` where every domain checker (`fs`, `network`, `childProcess`, `env`) returns `{ allow: true }`.

#### Scenario: Runtime created with allowAll permits all operations
- **WHEN** a `NodeRuntime` is created with `permissions: allowAll` and a filesystem adapter
- **THEN** all filesystem operations SHALL succeed without `EACCES` errors

#### Scenario: allowAll is a valid Permissions object
- **WHEN** `allowAll` is assigned to a variable of type `Permissions`
- **THEN** it SHALL compile without type errors

### Requirement: Per-domain permission helpers
The system SHALL export per-domain allow helpers: `allowAllFs`, `allowAllNetwork`, `allowAllChildProcess`, `allowAllEnv`. Each SHALL be a partial `Permissions` object containing only the corresponding domain checker returning `{ allow: true }`.

#### Scenario: Compose per-domain helpers for selective access
- **WHEN** a `NodeRuntime` is created with `permissions: { ...allowAllFs, ...allowAllNetwork }` and both filesystem and network adapters
- **THEN** filesystem and network operations SHALL succeed, while child-process and env operations SHALL throw `EACCES`

### Requirement: Explicit deny overrides adapter presence
When a `PermissionCheck` callback returns `{ allow: false }`, the operation SHALL be denied regardless of whether the underlying adapter is capable of performing it.

#### Scenario: Permission checker denies a specific path
- **WHEN** `permissions.fs` returns `{ allow: false }` for path `/secret` and the filesystem adapter has the file
- **THEN** `fs.readFile("/secret")` SHALL throw an `EACCES` error (unchanged from current behavior)

### Requirement: Kernel-Level Permission Wrapping Interacts With Secure-Exec Permissions
When a kernel is available, the kernel's `wrapFileSystem` deny-by-default permission layer operates at the VFS level, complementing the existing secure-exec `Permissions` model. Both layers enforce independently and the most restrictive policy wins.

#### Scenario: Kernel wrapFileSystem and secure-exec permissions both deny by default
- **WHEN** a kernel-mediated environment is configured with both kernel-level `wrapFileSystem` and secure-exec `Permissions` and neither grants access for a given operation
- **THEN** the operation MUST be denied, with the kernel VFS permission layer rejecting the operation before it reaches the secure-exec permission wrapper

#### Scenario: Kernel allows but secure-exec denies
- **WHEN** the kernel's `wrapFileSystem` permission check allows a filesystem operation but the secure-exec `Permissions` object denies it
- **THEN** the operation MUST still be denied by the secure-exec permission layer, because both layers enforce independently

#### Scenario: Secure-exec allows but kernel denies
- **WHEN** the secure-exec `Permissions` object would allow a filesystem operation but the kernel's `wrapFileSystem` denies it
- **THEN** the operation MUST be denied at the kernel VFS layer before reaching the secure-exec permission check

#### Scenario: Kernel permissions apply to all mounted drivers uniformly
- **WHEN** multiple RuntimeDrivers are mounted in the kernel (e.g., Node, WasmVM, Python)
- **THEN** the kernel's `wrapFileSystem` permission checks MUST apply uniformly to all drivers sharing the kernel VFS, providing a single enforcement point for cross-runtime permission policy

#### Scenario: Kernel filterEnv applies before driver-level env access
- **WHEN** a process spawned through the kernel accesses environment variables
- **THEN** the kernel's `filterEnv` MUST filter the environment before the driver receives it in `ProcessContext.env`, and driver-level env access MUST only see pre-filtered keys

### Requirement: Projected Node-Modules Paths MUST Be Read-Only
When driver-managed node_modules overlay/projection is active (including always-on `/app/node_modules` overlay), projected sandbox module paths (including `/app/node_modules` and descendants) MUST be treated as read-only runtime state.

#### Scenario: Host-absolute package asset reads stay inside the projected closure
- **WHEN** sandboxed package code derives a host-absolute path for its own projected module files from `import.meta.url`, `__filename`, or `realpath()` and then reads sibling assets such as `package.json`, `README.md`, or bundled theme/template files
- **THEN** those read operations MUST succeed when the canonical path still resolves inside the configured projected `node_modules` closure
- **AND** the same host-absolute projected paths MUST remain read-only for write, rename, mkdir, unlink, and rmdir operations

#### Scenario: Pnpm virtual-store dependency targets stay inside the projected closure
- **WHEN** a projected package resolves a transitive dependency through pnpm virtual-store symlinks (for example package-internal `imports` such as Chalk resolving `#ansi-styles` to another package directory under `.pnpm/.../node_modules/...`)
- **THEN** the module overlay MUST treat those canonical dependency paths as part of the same read-only projected closure
- **AND** sandboxed reads of those host-absolute dependency files MUST succeed without granting access to unrelated host filesystem paths outside the reachable package closure

#### Scenario: Sandboxed write targets projected module file
- **WHEN** sandboxed code attempts `writeFile`, `unlink`, or `rename` for a path under projected `/app/node_modules`
- **THEN** the operation MUST be denied with `EACCES` regardless of broader filesystem allow rules

#### Scenario: Sandboxed directory mutation targets projected module tree
- **WHEN** sandboxed code attempts `mkdir` or `rmdir` under projected `/app/node_modules`
- **THEN** the operation MUST be denied with `EACCES`

### Requirement: Module Projection MUST Preserve Deny-By-Default Outside Allowed Closure
Node-modules overlay access SHALL NOT grant implicit read access to non-overlay host filesystem paths, and deny-by-default behavior MUST remain intact outside `/app/node_modules` when permission checks do not allow access.

#### Scenario: Sandbox attempts to read host path outside projected closure
- **WHEN** module projection is configured and sandboxed code accesses a filesystem path outside the projected closure without explicit fs permission allowance
- **THEN** access MUST remain denied by existing deny-by-default permission behavior

#### Scenario: Overlay availability does not auto-allow unrelated host reads
- **WHEN** always-on `/app/node_modules` overlay is available and sandboxed code attempts to read `/etc/passwd` without explicit fs permission allowance
- **THEN** runtime MUST deny the read with `EACCES`
