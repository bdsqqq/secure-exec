## ADDED Requirements

### Requirement: Runtime Filesystem Metadata Access Is Driver-Native
Sandbox runtime filesystem metadata operations MUST use driver metadata APIs and MUST NOT derive metadata by reading full file contents.

#### Scenario: Stat call on large file does not require content read
- **WHEN** sandboxed code performs `stat` on a large file path
- **THEN** the runtime MUST resolve metadata via driver `stat` behavior and MUST NOT read the file body to compute size/type

#### Scenario: Exists check uses metadata/access path
- **WHEN** sandboxed code performs an existence check on a file or directory path
- **THEN** the runtime MUST use metadata/access operations and MUST NOT probe existence by loading entire file contents

### Requirement: Runtime Directory Type Enumeration Avoids Per-Entry Re-Probing
When sandboxed code requests directory entries with type information, the runtime MUST return type metadata from one directory traversal and MUST NOT perform an additional directory probe per entry.

#### Scenario: Mixed directory listing returns types without N+1 probes
- **WHEN** a directory contains both files and subdirectories and sandboxed code requests typed entries
- **THEN** the runtime MUST return each entry with correct `isDirectory` information without issuing per-entry `readDir` probes

### Requirement: Runtime Rename Delegates to Driver Rename Semantics
Runtime rename behavior MUST delegate to the active driver `rename` operation and MUST NOT emulate rename with copy-write-delete in the default runtime path.

#### Scenario: Atomic rename path is preserved when supported
- **WHEN** the active driver supports atomic rename semantics
- **THEN** sandboxed `rename` MUST complete through that atomic driver operation

#### Scenario: Unsupported atomic rename is explicit and deterministic
- **WHEN** the active driver cannot provide atomic rename semantics
- **THEN** the runtime MUST expose deterministic documented behavior for that driver and MUST NOT silently perform copy-write-delete emulation as if it were atomic
