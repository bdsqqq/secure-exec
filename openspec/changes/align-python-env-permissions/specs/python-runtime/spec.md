## ADDED Requirements

### Requirement: Python Exec Env Overrides Must Respect Env Permissions
Python `exec()` env overrides SHALL be filtered through the configured `SystemDriver.permissions.env` gate before they are applied inside the runtime.

#### Scenario: Python exec env overrides are denied by default
- **WHEN** a caller passes `exec(..., { env })` to `PythonRuntime` and `permissions.env` does not allow those keys
- **THEN** the denied env keys MUST NOT become visible inside the Python runtime

#### Scenario: Python exec env overrides are exposed only when permitted
- **WHEN** a caller passes `exec(..., { env })` to `PythonRuntime` and `permissions.env` explicitly allows a key
- **THEN** that key MUST be visible inside the Python runtime with the provided value
