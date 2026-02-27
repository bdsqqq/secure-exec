## ADDED Requirements

### Requirement: Bridge FS Open Flag Translation Uses Named Constants
The bridge `fs` implementation MUST express string-flag translation using named open-flag constants (for example `O_WRONLY | O_CREAT | O_TRUNC`) aligned with Node `fs.constants` semantics, and MUST NOT rely on undocumented numeric literals.

#### Scenario: Write-truncate flags are composed from constants
- **WHEN** the bridge parses open flag strings such as `"w"` or `"w+"`
- **THEN** resulting numeric modes MUST be produced from named constant composition rather than hardcoded integers

#### Scenario: Append-exclusive flags remain deterministic
- **WHEN** the bridge parses append/exclusive flags such as `"ax"` and `"ax+"`
- **THEN** the bridge MUST return deterministic Node-compatible numeric modes and preserve existing error behavior for unknown flags

### Requirement: Bridge Filesystem Metadata Calls Preserve Metadata-Only Semantics
Bridge-exposed filesystem metadata calls (`exists`, `stat`, and typed directory listing paths) MUST preserve metadata-only semantics and MUST NOT trigger file-content reads solely to determine type or existence.

#### Scenario: Bridge stat does not read file body for metadata
- **WHEN** sandboxed code calls bridge `fs.stat` for a file path
- **THEN** bridge handling MUST obtain metadata without loading the file body into memory

#### Scenario: Bridge typed readdir avoids per-entry directory probing
- **WHEN** sandboxed code calls bridge `readdir` with typed entry expectations
- **THEN** bridge handling MUST return entry type information without a repeated `readDir` probe for each entry
