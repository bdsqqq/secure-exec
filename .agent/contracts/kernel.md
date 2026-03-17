# kernel Specification

## Purpose
Define behavioral contracts for the kernel OS layer: VFS interface semantics, FD table lifecycle, process table management, device layer intercepts, pipe manager blocking/EOF, command registry resolution, and permission deny-by-default wrapping.

## Requirements

### Requirement: VFS Interface Semantics
The kernel VFS SHALL provide a POSIX-like filesystem interface with consistent error behavior across all implementations (InMemoryFileSystem, NodeFileSystem, TestFileSystem).

#### Scenario: Read file returns content as bytes
- **WHEN** a caller invokes `readFile(path)` on an existing file
- **THEN** the VFS MUST return the file content as `Uint8Array`

#### Scenario: Read non-existent file throws ENOENT
- **WHEN** a caller invokes `readFile(path)` on a path that does not exist
- **THEN** the VFS MUST throw an error with code `ENOENT`

#### Scenario: Write file creates or overwrites content
- **WHEN** a caller invokes `writeFile(path, content)` with bytes or string content
- **THEN** the VFS MUST create the file if absent or overwrite if present, and subsequent `readFile` MUST return the written content

#### Scenario: mkdir with recursive option creates intermediate directories
- **WHEN** a caller invokes `mkdir(path, { recursive: true })` where intermediate directories do not exist
- **THEN** the VFS MUST create all intermediate directories along the path

#### Scenario: removeFile deletes a file
- **WHEN** a caller invokes `removeFile(path)` on an existing regular file
- **THEN** the file MUST be deleted and subsequent `exists(path)` MUST return false

#### Scenario: removeDir deletes a directory
- **WHEN** a caller invokes `removeDir(path)` on an existing empty directory
- **THEN** the directory MUST be deleted

#### Scenario: rename moves a file atomically within the VFS
- **WHEN** a caller invokes `rename(oldPath, newPath)`
- **THEN** the file MUST be accessible at `newPath` and MUST NOT exist at `oldPath`

#### Scenario: stat returns VirtualStat with correct metadata
- **WHEN** a caller invokes `stat(path)` on an existing file or directory
- **THEN** the VFS MUST return a `VirtualStat` with `isDirectory`, `isSymbolicLink`, `size`, `mode`, `ino`, `nlink`, `uid`, `gid`, and timestamp fields (`atime`, `mtime`, `ctime`, `birthtime` in milliseconds)

#### Scenario: symlink and readlink round-trip
- **WHEN** a caller invokes `symlink(target, linkPath)` followed by `readlink(linkPath)`
- **THEN** `readlink` MUST return the original `target` path

#### Scenario: lstat does not follow symlinks
- **WHEN** a caller invokes `lstat(path)` on a symlink
- **THEN** the returned `VirtualStat` MUST describe the symlink itself, with `isSymbolicLink` returning true

#### Scenario: link creates a hard link sharing content
- **WHEN** a caller invokes `link(oldPath, newPath)`
- **THEN** both paths MUST reference the same content, and `stat` for both MUST report `nlink >= 2`

#### Scenario: readDirWithTypes returns entries with type information
- **WHEN** a caller invokes `readDirWithTypes(path)` on a directory containing files and subdirectories
- **THEN** the VFS MUST return `VirtualDirEntry[]` where each entry has `name`, `isDirectory`, and `isSymbolicLink` fields

#### Scenario: chmod updates file permissions
- **WHEN** a caller invokes `chmod(path, mode)` on an existing file
- **THEN** subsequent `stat(path)` MUST reflect the updated `mode`

#### Scenario: truncate reduces file to specified length
- **WHEN** a caller invokes `truncate(path, length)` where length is less than current file size
- **THEN** subsequent `readFile(path)` MUST return content of exactly `length` bytes

### Requirement: FD Table Open/Close/Dup/Dup2/Fork Lifecycle
The kernel FD table SHALL manage per-process file descriptor allocation with reference-counted FileDescriptions and correct inheritance semantics.

#### Scenario: Open allocates the lowest available FD
- **WHEN** a process opens a file via `fdOpen(pid, path, flags)`
- **THEN** the FD table MUST allocate and return the lowest available file descriptor number

#### Scenario: Close decrements reference count and releases FD
- **WHEN** a process closes an FD via `fdClose(pid, fd)`
- **THEN** the FD entry MUST be removed from the process table and the underlying FileDescription's `refCount` MUST be decremented

#### Scenario: Close last reference cleans up FileDescription
- **WHEN** the last FD referencing a FileDescription is closed (refCount reaches 0)
- **THEN** the FileDescription MUST be eligible for cleanup

#### Scenario: Dup creates a new FD sharing the same FileDescription
- **WHEN** a process duplicates an FD via `fdDup(pid, fd)`
- **THEN** a new FD MUST be allocated pointing to the same FileDescription, and the FileDescription's `refCount` MUST be incremented

#### Scenario: Dup2 redirects target FD to source FileDescription
- **WHEN** a process invokes `fdDup2(pid, oldFd, newFd)` and `newFd` is already open
- **THEN** `newFd` MUST be closed first, then reassigned to share `oldFd`'s FileDescription with `refCount` incremented

#### Scenario: Dup2 with same source and target is a no-op
- **WHEN** a process invokes `fdDup2(pid, fd, fd)` where oldFd equals newFd
- **THEN** the operation MUST succeed without closing or modifying the FD

#### Scenario: Fork copies the entire FD table to child process
- **WHEN** a process forks via `fork(parentPid, childPid)`
- **THEN** the child MUST receive a copy of all parent FD entries, each sharing the same FileDescription objects with `refCount` incremented for every inherited FD

#### Scenario: Stdio FDs 0, 1, 2 are pre-allocated
- **WHEN** a new FD table is created via `create(pid)` or `createWithStdio(pid, ...)`
- **THEN** FDs 0 (stdin), 1 (stdout), and 2 (stderr) MUST be pre-allocated before any user open calls

#### Scenario: FD cursor is shared across duplicated descriptors
- **WHEN** two FDs share a FileDescription (via dup or fork) and one advances the cursor via seek or read
- **THEN** both FDs MUST observe the updated cursor position since they share the same FileDescription

#### Scenario: closeAll releases all FDs on process exit
- **WHEN** a process exits and `closeAll()` is invoked on its FD table
- **THEN** all FDs MUST be closed and all FileDescription refCounts MUST be decremented

### Requirement: Process Table Register/Waitpid/Kill/Zombie Cleanup
The kernel process table SHALL manage process lifecycle with atomic PID allocation, signal delivery, and time-bounded zombie cleanup.

#### Scenario: allocatePid returns monotonically increasing PIDs
- **WHEN** the process table allocates PIDs via `allocatePid()`
- **THEN** each returned PID MUST be strictly greater than any previously allocated PID

#### Scenario: Register creates a running process entry
- **WHEN** a process is registered via `register(pid, driver, command, args, ctx, driverProcess)`
- **THEN** `get(pid)` MUST return a ProcessEntry with `status: "running"` and `exitCode: null`

#### Scenario: markExited transitions process to exited state
- **WHEN** `markExited(pid, exitCode)` is called on a running process
- **THEN** the process entry MUST transition to `status: "exited"` with the provided `exitCode` and `exitTime` set to the current timestamp

#### Scenario: waitpid resolves when process exits
- **WHEN** a caller invokes `waitpid(pid)` on a running process that later exits with code 0
- **THEN** the returned Promise MUST resolve with `{ pid, status: 0 }`

#### Scenario: waitpid on already-exited process resolves immediately
- **WHEN** a caller invokes `waitpid(pid)` on a process that has already exited
- **THEN** the Promise MUST resolve immediately with the recorded exit status

#### Scenario: kill sends signal to running process via driver
- **WHEN** a caller invokes `kill(pid, signal)` on a running process
- **THEN** the kernel MUST route the signal through `driverProcess.kill(signal)` on the process's DriverProcess handle

#### Scenario: kill on exited process is a no-op or throws
- **WHEN** a caller invokes `kill(pid, signal)` on a process with `status: "exited"`
- **THEN** the kernel MUST NOT attempt to deliver the signal to the driver

#### Scenario: Zombie processes are cleaned up after TTL
- **WHEN** a process exits and transitions to zombie state
- **THEN** the process entry MUST be cleaned up (removed from the table) after a bounded TTL (60 seconds)

#### Scenario: getppid returns parent PID
- **WHEN** a child process was spawned by a parent process
- **THEN** `getppid(childPid)` MUST return the parent's PID

#### Scenario: terminateAll sends SIGTERM to all running processes
- **WHEN** `terminateAll()` is invoked during kernel dispose
- **THEN** all running processes MUST receive SIGTERM, and after a bounded grace period, remaining processes MUST be force-cleaned

#### Scenario: listProcesses returns introspection snapshot
- **WHEN** `listProcesses()` is invoked
- **THEN** it MUST return a Map of PID to ProcessInfo containing `pid`, `ppid`, `driver`, `command`, `status`, and `exitCode` for every registered process

### Requirement: Device Layer Intercepts and EPERM Rules
The kernel device layer SHALL transparently intercept `/dev/*` paths with fixed device semantics, pass non-device paths through to the underlying VFS, and deny mutation operations on devices.

#### Scenario: /dev/null read returns empty
- **WHEN** a read operation targets `/dev/null`
- **THEN** the device layer MUST return 0 bytes (empty Uint8Array)

#### Scenario: /dev/null write discards data
- **WHEN** a write operation targets `/dev/null`
- **THEN** the device layer MUST accept and discard the data without error

#### Scenario: /dev/zero read returns zero-filled bytes
- **WHEN** a read operation targets `/dev/zero`
- **THEN** the device layer MUST return a buffer of zero bytes (up to 4096 bytes)

#### Scenario: /dev/urandom read returns random bytes
- **WHEN** a read operation targets `/dev/urandom`
- **THEN** the device layer MUST return a buffer of random bytes (up to 4096 bytes) sourced from `crypto.getRandomValues` or a fallback

#### Scenario: Device stat returns fixed inode numbers
- **WHEN** `stat()` is called on a device path (e.g., `/dev/null`, `/dev/zero`, `/dev/urandom`)
- **THEN** the device layer MUST return a VirtualStat with a fixed inode number in the `0xffff_000X` range

#### Scenario: Remove or rename on device path throws EPERM
- **WHEN** a caller invokes `removeFile`, `removeDir`, or `rename` on a `/dev/*` path
- **THEN** the device layer MUST throw an error with code `EPERM`

#### Scenario: Link on device path throws EPERM
- **WHEN** a caller invokes `link` targeting a `/dev/*` path
- **THEN** the device layer MUST throw an error with code `EPERM`

#### Scenario: chmod/chown/utimes on device paths are no-ops
- **WHEN** a caller invokes `chmod`, `chown`, or `utimes` on a `/dev/*` path
- **THEN** the device layer MUST succeed silently without modifying any state

#### Scenario: /dev directory listing returns standard entries
- **WHEN** `readDir("/dev")` or `readDirWithTypes("/dev")` is called
- **THEN** the device layer MUST return standard device entries (`null`, `zero`, `urandom`, `stdin`, `stdout`, `stderr`)

#### Scenario: Non-device paths pass through to underlying VFS
- **WHEN** any filesystem operation targets a path outside `/dev/`
- **THEN** the device layer MUST delegate the operation to the underlying VFS without interception

### Requirement: Pipe Manager Blocking Read/EOF/Drain
The kernel pipe manager SHALL provide buffered unidirectional pipes with blocking read semantics and proper EOF signaling on write-end closure.

#### Scenario: createPipe returns paired read and write ends
- **WHEN** `createPipe()` is invoked
- **THEN** the pipe manager MUST return `{ read, write }` PipeEnd objects with distinct FileDescriptions and `FILETYPE_PIPE` filetype

#### Scenario: Write delivers data to blocked reader
- **WHEN** data is written to a pipe's write end and a reader is blocked waiting
- **THEN** the data MUST be delivered directly to the waiting reader without buffering

#### Scenario: Write buffers data when no reader is waiting
- **WHEN** data is written to a pipe's write end and no reader is currently blocked
- **THEN** the data MUST be buffered in the pipe state for later reads

#### Scenario: Read returns buffered data immediately
- **WHEN** a read is performed on a pipe's read end and data is available in the buffer
- **THEN** the read MUST return the buffered data immediately without blocking

#### Scenario: Read blocks when buffer is empty and write end is open
- **WHEN** a read is performed on a pipe's read end with an empty buffer and the write end is still open
- **THEN** the read MUST block (return a pending Promise) until data is written or the write end is closed

#### Scenario: Read returns null (EOF) when write end is closed and buffer is empty
- **WHEN** a read is performed on a pipe's read end after the write end has been closed and the buffer is drained
- **THEN** the read MUST return `null` signaling EOF

#### Scenario: Closing write end notifies all blocked readers with EOF
- **WHEN** the write end of a pipe is closed and readers are blocked waiting for data
- **THEN** all blocked readers MUST be notified with `null` (EOF)

#### Scenario: Pipes work across runtime drivers
- **WHEN** a pipe connects a process in one runtime driver (e.g., WasmVM) to a process in another (e.g., Node)
- **THEN** data MUST flow through the kernel pipe manager transparently, with the same blocking/EOF semantics

#### Scenario: createPipeFDs installs both ends in process FD table
- **WHEN** `createPipeFDs(fdTable)` is invoked
- **THEN** the pipe manager MUST create a pipe and install both read and write FileDescriptions as FDs in the specified FD table, returning `{ readFd, writeFd }`

### Requirement: Command Registry Resolution and /bin Population
The kernel command registry SHALL map command names to runtime drivers and populate `/bin` stubs for shell PATH-based resolution.

#### Scenario: Register adds driver commands to the registry
- **WHEN** `register(driver)` is called with a RuntimeDriver whose `commands` array contains `["grep", "sed", "awk"]`
- **THEN** all three commands MUST be resolvable via `resolve(command)` returning that driver

#### Scenario: Last-registered driver wins on command conflicts
- **WHEN** two drivers register the same command name
- **THEN** `resolve(command)` MUST return the last-registered driver for that command

#### Scenario: Resolve returns null for unregistered commands
- **WHEN** `resolve(command)` is called with a command that no driver has registered
- **THEN** the registry MUST return `null`

#### Scenario: list returns all registered command-to-driver mappings
- **WHEN** `list()` is called after drivers are registered
- **THEN** it MUST return a Map of command names to driver names for all registered commands

#### Scenario: populateBin creates stub files for all commands
- **WHEN** `populateBin(vfs)` is called
- **THEN** the registry MUST create `/bin` directory (if absent) and write a stub file for each registered command so that shell PATH lookup can resolve them

### Requirement: Permission Deny-by-Default Wrapping
The kernel permission system SHALL wrap VFS and environment access with deny-by-default permission checks, failing closed when no permission is configured.

#### Scenario: No permission configured denies all operations
- **WHEN** a VFS is wrapped via `wrapFileSystem(fs, permissions)` with no `fs` permission check configured
- **THEN** all filesystem operations MUST be denied by default

#### Scenario: Allowed operation passes through to underlying VFS
- **WHEN** a VFS is wrapped with a permission check that returns `{ allow: true }` for a given operation
- **THEN** the operation MUST be delegated to the underlying VFS and return its result

#### Scenario: Denied operation throws permission error
- **WHEN** a VFS is wrapped and the permission check returns `{ allow: false, reason: "..." }` for a given operation
- **THEN** the operation MUST throw an error indicating permission denial with the provided reason

#### Scenario: filterEnv only returns allowed environment keys
- **WHEN** `filterEnv(env, permissions)` is called with an env permission check
- **THEN** only environment keys for which the permission check returns `{ allow: true }` MUST be included in the filtered result

#### Scenario: Permission checks receive correct operation metadata
- **WHEN** a permission-wrapped VFS operation is invoked (e.g., `readFile("/etc/passwd")`)
- **THEN** the permission check MUST receive an `FsAccessRequest` with the correct `op` (e.g., `"read"`) and `path`

#### Scenario: Network and child-process permissions follow deny-by-default
- **WHEN** network or child-process permission checks are configured
- **THEN** operations without explicit allowance MUST be denied, consistent with the fs permission model

#### Scenario: Preset allowAll grants all operations
- **WHEN** `allowAll` permission preset is used
- **THEN** all filesystem, network, child-process, and env operations MUST be allowed
