## 1. Python Env Permission Alignment

- [x] 1.1 Filter `PyodideRuntimeDriver.exec()` env overrides through `permissions.env` before dispatching worker requests.
- [x] 1.2 Add regression coverage for denied-by-default and explicitly-allowed Python env overrides.
- [x] 1.3 Update internal to-do/friction tracking so the documented follow-up state matches the code.
