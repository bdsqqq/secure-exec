# kernel-runtime-driver Specification

## Purpose
Define behavioral contracts for the RuntimeDriver interface, command registration rules, ProcessContext requirements, and DriverProcess exit/kill/stdio contract.

## Requirements

### Requirement: RuntimeDriver Interface Lifecycle
A RuntimeDriver SHALL implement `init`, `spawn`, and `dispose` lifecycle methods, enabling pluggable runtime registration with the kernel.

#### Scenario: init receives kernel interface and prepares driver resources
- **WHEN** the kernel mounts a RuntimeDriver via `mount(driver)`
- **THEN** the kernel MUST call `driver.init(kernel)` with a KernelInterface reference, and the driver MUST use this phase to prepare resources (e.g., compile WASM, load Pyodide)

#### Scenario: init completes before commands are registered
- **WHEN** a RuntimeDriver is mounted
- **THEN** `init` MUST complete (Promise resolves) before the driver's commands are registered in the command registry

#### Scenario: dispose releases all driver-managed resources
- **WHEN** `driver.dispose()` is called during kernel shutdown
- **THEN** the driver MUST release all resources (workers, interpreters, compiled modules) and MUST NOT hold references that prevent garbage collection

#### Scenario: Driver exposes a unique name
- **WHEN** a RuntimeDriver is constructed
- **THEN** `driver.name` MUST be a non-empty string uniquely identifying the runtime (e.g., `"wasmvm"`, `"node"`, `"python"`)

### Requirement: Command Registration Rules
Each RuntimeDriver SHALL declare a static `commands` array listing all command names the driver can execute, and the kernel SHALL register these during mount.

#### Scenario: Commands array lists all executable commands
- **WHEN** a RuntimeDriver is constructed
- **THEN** `driver.commands` MUST be a string array listing every command the driver can spawn (e.g., `["grep", "sed", "cat", "ls"]`)

#### Scenario: All declared commands are registered on mount
- **WHEN** `kernel.mount(driver)` completes
- **THEN** every command in `driver.commands` MUST be resolvable in the kernel command registry, mapping to this driver

#### Scenario: Unregistered commands cannot be spawned
- **WHEN** a caller attempts to spawn a command not registered by any mounted driver
- **THEN** the kernel MUST fail with a command-not-found error rather than silently ignoring the spawn

#### Scenario: Multiple drivers can be mounted
- **WHEN** multiple RuntimeDrivers are mounted sequentially
- **THEN** each driver's commands MUST be registered, and the command registry MUST resolve each command to its owning driver (last-registered wins on conflicts)

### Requirement: ProcessContext Requirements
The kernel SHALL construct a ProcessContext for each spawned process, providing the process with its identity, environment, working directory, and stdio FD numbers.

#### Scenario: ProcessContext contains process identity
- **WHEN** the kernel spawns a process
- **THEN** the ProcessContext MUST include `pid` (the allocated PID) and `ppid` (the parent's PID)

#### Scenario: ProcessContext contains environment and working directory
- **WHEN** the kernel spawns a process with env and cwd options
- **THEN** the ProcessContext MUST include `env` (merged environment) and `cwd` (working directory path)

#### Scenario: ProcessContext contains stdio FD numbers
- **WHEN** the kernel spawns a process
- **THEN** the ProcessContext MUST include `fds: { stdin, stdout, stderr }` with the FD numbers allocated in the child's FD table

#### Scenario: Piped stdio omits onStdout/onStderr callbacks
- **WHEN** the kernel spawns a process with `stdio: "pipe"` (or FD overrides)
- **THEN** `onStdout` and `onStderr` in ProcessContext MUST be undefined, because data flows through kernel pipes

#### Scenario: Inherited stdio provides onStdout/onStderr callbacks
- **WHEN** the kernel spawns a process with `stdio: "inherit"` or default stdio
- **THEN** `onStdout` and `onStderr` in ProcessContext MUST be callback functions that route output to the parent's stdio handling

### Requirement: DriverProcess Exit Contract
A DriverProcess returned by `driver.spawn()` SHALL communicate process completion through `wait()` and `onExit`, with the exit code as the authoritative status.

#### Scenario: wait() resolves with exit code on normal termination
- **WHEN** a spawned process completes execution normally
- **THEN** `driverProcess.wait()` MUST resolve with the process's integer exit code (0 for success, non-zero for failure)

#### Scenario: onExit callback fires on process exit
- **WHEN** a spawned process exits and `onExit` is set
- **THEN** the driver MUST invoke `onExit(exitCode)` with the exit code

#### Scenario: Exit triggers kernel markExited
- **WHEN** a DriverProcess exits (via `onExit` or `wait()` resolution)
- **THEN** the kernel MUST call `processTable.markExited(pid, exitCode)` to transition the process entry and notify waitpid callers

#### Scenario: Exit code 0 indicates success
- **WHEN** a process completes without error
- **THEN** the exit code MUST be 0

#### Scenario: Non-zero exit code indicates failure
- **WHEN** a process encounters an error or explicit failure
- **THEN** the exit code MUST be non-zero, with the specific value determined by the runtime driver

### Requirement: DriverProcess Kill Contract
A DriverProcess SHALL accept kill signals routed from the kernel, and MUST transition to an exited state after receiving a termination signal.

#### Scenario: kill(SIGTERM) requests graceful termination
- **WHEN** `driverProcess.kill(SIGTERM)` is called
- **THEN** the driver MUST initiate graceful shutdown of the process, allowing cleanup before exit

#### Scenario: kill(SIGKILL) forces immediate termination
- **WHEN** `driverProcess.kill(SIGKILL)` is called
- **THEN** the driver MUST terminate the process immediately without cleanup, and `wait()` MUST resolve promptly

#### Scenario: Kill on already-exited process is safe
- **WHEN** `driverProcess.kill(signal)` is called after the process has already exited
- **THEN** the call MUST NOT throw or cause side effects

### Requirement: DriverProcess Stdio Contract
A DriverProcess SHALL support stdin write/close from the kernel and push stdout/stderr data to the kernel via callbacks.

#### Scenario: writeStdin delivers data to the process
- **WHEN** the kernel calls `driverProcess.writeStdin(data)` with a Uint8Array
- **THEN** the driver MUST deliver the data to the process's standard input

#### Scenario: closeStdin signals end of input
- **WHEN** the kernel calls `driverProcess.closeStdin()`
- **THEN** the driver MUST signal EOF on the process's standard input, allowing the process to detect end-of-input

#### Scenario: onStdout pushes output data to kernel
- **WHEN** the spawned process writes to stdout and `onStdout` is set on the DriverProcess
- **THEN** the driver MUST call `onStdout(data)` with the output as `Uint8Array`

#### Scenario: onStderr pushes error data to kernel
- **WHEN** the spawned process writes to stderr and `onStderr` is set on the DriverProcess
- **THEN** the driver MUST call `onStderr(data)` with the error output as `Uint8Array`

#### Scenario: Stdio callbacks are optional
- **WHEN** `onStdout` or `onStderr` is null on the DriverProcess
- **THEN** the driver MUST discard the corresponding output without error

### Requirement: Kernel Spawn Orchestration
The kernel `spawn()` method SHALL orchestrate PID allocation, FD table creation, command resolution, driver dispatch, and process registration as a single coherent operation.

#### Scenario: Spawn allocates PID before driver dispatch
- **WHEN** `kernel.spawn(command, args, options)` is called
- **THEN** the kernel MUST allocate a PID via the process table before invoking `driver.spawn()`

#### Scenario: Spawn creates FD table with stdio configuration
- **WHEN** a process is spawned with pipe or inherited stdio
- **THEN** the kernel MUST create a per-process FD table with FDs 0/1/2 configured according to the stdio option before passing the ProcessContext to the driver

#### Scenario: Spawn resolves command through registry
- **WHEN** `kernel.spawn(command, args, options)` is called
- **THEN** the kernel MUST resolve `command` through the command registry to find the owning RuntimeDriver

#### Scenario: Spawn registers process in process table
- **WHEN** the driver returns a DriverProcess from `spawn()`
- **THEN** the kernel MUST register the process in the process table with `status: "running"` before returning the ManagedProcess handle

#### Scenario: Spawn returns ManagedProcess with pid and control methods
- **WHEN** `kernel.spawn()` completes
- **THEN** the returned ManagedProcess MUST expose `pid`, `writeStdin()`, `closeStdin()`, `kill()`, `wait()`, and `exitCode`

### Requirement: Kernel Exec Convenience
The kernel `exec()` method SHALL provide a high-level execute-and-collect interface that spawns a shell command, captures stdout/stderr, and returns a structured result.

#### Scenario: exec returns ExecResult with exitCode, stdout, stderr
- **WHEN** `kernel.exec(command, options)` is called and the command completes
- **THEN** the result MUST contain `exitCode` (number), `stdout` (string), and `stderr` (string)

#### Scenario: exec routes through shell
- **WHEN** `kernel.exec(command)` is called
- **THEN** the kernel MUST spawn the command through the registered shell (e.g., `sh -c command`) for proper argument parsing and pipeline support

#### Scenario: exec respects timeout option
- **WHEN** `kernel.exec(command, { timeout })` is called and the command exceeds the timeout
- **THEN** the kernel MUST terminate the process and return a failure result

#### Scenario: exec delivers stdin option to process
- **WHEN** `kernel.exec(command, { stdin: "input data" })` is called
- **THEN** the kernel MUST write the stdin data to the process's standard input and close stdin
