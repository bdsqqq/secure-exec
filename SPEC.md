# lightweight sandbox

## overview

goal: design an emulated linux machine for Node.js (not browser) using WebAssembly.sh for Linux emulation and isolated-vm for the node emulation. these are both bound to the same core "virtual machine" for filesystem & network & etc. this allows for emulating a linux environment without sacrificing performance (mostly, polyfills have some overhead) on the NodeJS app since it's in an isolate.

the closest prior art is WebContainers, OpenWebContainers, and Nodebox. however, these all target the browser or use pure WASM. this project targets Node.js as the host runtime.

## project structure

- use typescript
- keep all in a single package in src/
- add a script check-types to check that types are working
- use vitest to test your work

loosely follow this structure, keep things simple:

```
src/
    vm/
        index.ts  # class VirtualMachine - orchestrates WasixInstance and NodeProcess
        ...etc...
    system-bridge/
        index.ts  # class SystemBridge - shared filesystem, network, etc
        fs.ts     # filesystem implementation
        ...etc...
    node-process/
        index.ts  # class NodeProcess (using isolated-vm)
        ...etc...
    wasix/
        index.ts  # class WasixInstance
        ...etc...
```

the end user api looks like:

```
const vm = new VirtualMachine("/path/to/local/fs");
const output = await vm.spawn("ls", ["/"]);
console.log('output', output.stdout, output.stderr, output.code)
```

**v1 goal** - run node scripts and linux commands separately:

```ts
const vm = new VirtualMachine("/path/to/local/fs");

// run linux commands via WASM
const lsResult = await vm.spawn("ls", ["/"]);
console.log(lsResult.stdout); // lists files

// run node scripts via isolated-vm (assumes pnpm add ms jsonfile in host dir)
vm.writeFile("/script.js", `
  const ms = require("ms");
  const jsonfile = require("jsonfile");
  console.log("1 hour in ms:", ms("1h"));
  jsonfile.writeFileSync("/test.json", { hello: "world" });
`);

const nodeResult = await vm.spawn("node", ["/script.js"]);
console.log(nodeResult.stdout); // "1 hour in ms: 3600000"

// read back file written by node
const raw = vm.readFile("/test.json");
console.log(JSON.parse(raw)); // { hello: "world" }
```

**stretch goal** - shell scripts that call node (proven viable via file-based IPC, see [test 18](scratch/wasmer-test/test18-fs-polling-ipc.ts)):

```ts
const vm = new VirtualMachine("/path/to/local/fs");

vm.writeFile("/test.sh", `#!/bin/sh
node script.js
echo "done"
`);

// shell runs in WASM, delegates "node" back to JS → NodeProcess
const output = await vm.spawn("sh", ["/test.sh"]);
```

## components

### virtual machine

orchestrates WasixInstance and NodeProcess. provides the main `spawn()` API that routes commands to the appropriate runtime. owns the SystemBridge instance that both runtimes share.

### system bridge

shared layer for filesystem, network, and other system resources. wraps a dedicated folder on the host filesystem.

**filesystem architecture:**
- SystemBridge wraps a host directory (e.g. `/tmp/vm-abc123/`)
- NodeProcess: fs polyfill calls back to main isolate via isolated-vm Reference API → SystemBridge → real host fs. full read/write.
- WasixInstance: before each command, sync host fs → Wasmer Directory class. WASM can read these files. WASM writes don't persist back (known limitation of Directory class).
- net effect: both runtimes see the same files. NodeProcess has full read/write, WasixInstance has read-only view.

### node process

runs Node.js code in an isolated-vm isolate. provides polyfilled node stdlib (fs, path, etc) that routes through SystemBridge. supports requiring packages from node_modules.

**fs bridging via isolated-vm Reference API:**
```ts
// main isolate creates references to real fs operations
const writeFileRef = new ivm.Reference((path: string, content: string) => {
  systemBridge.writeFile(path, content);
});

// pass reference into sandbox
await context.global.set('_bridgeWriteFile', writeFileRef);

// inside sandbox, fs polyfill calls back:
fs.writeFileSync = (path, content) => {
  _bridgeWriteFile.applySync(undefined, [path, content]);
};
```

**stdout/stderr capture:** use isolated-vm's `context.eval()` return value or pass a `_log` reference that collects output.

### wasix instance

uses @wasmer/sdk to run Linux commands. uses `sharrattj/coreutils` package from Wasmer registry for ls, cat, echo, etc.

### node shim

a rust-compiled WASM binary ([source](scratch/wasmer-node-shim/)) that acts as a `node` command within the WASM environment. when bash or other programs try to execute `node`, this shim intercepts the call and bridges to real Node.js via file-based IPC.

**protocol:**
1. shim writes args to `/ipc/request.txt` (one arg per line)
2. shim polls for `/ipc/response.txt`
3. host-side JS polls Directory, finds request, executes real `node`
4. host writes exit code + stdout to `/ipc/response.txt`
5. shim reads response, prints stdout, exits with code

**packaging:** bundled in a .webc file with bash + coreutils dependencies. the package exposes a `node` command that routes to our shim. loaded via `Wasmer.fromFile()`.

**limitations:**
- ~200-500ms latency per call (polling overhead)
- no streaming stdout/stderr (collected then returned)
- single request at a time (concurrent calls would need request IDs)

### dependencies

**@wasmer/sdk** - Wasmer's JavaScript SDK for running WASI/WASIX modules in Node.js. docs: https://wasmerio.github.io/wasmer-js/index.html

```bash
pnpm add @wasmer/sdk
```
provides:
- `Directory` class for virtual filesystem (writeFile, readFile, readDir, mount into WASM)
- stdout/stderr capture via `instance.wait()` or streaming
- run packages from Wasmer registry

**node-stdlib-browser** - pure JavaScript polyfills for Node.js stdlib modules. works in isolated-vm because it has no native bindings and doesn't require browser APIs (despite the name, it's just pure JS implementations).

```bash
pnpm add node-stdlib-browser
```

provides polyfills for: `buffer`, `events`, `stream`, `util`, `path`, `process`, `crypto` (partial), `assert`, `timers`, `url`, `querystring`, `os`, `console`, `vm`, `zlib`, etc.

modules that still need bridging to main isolate (real I/O): `fs`, `net`, `http`, `child_process`

**isolated-vm** - runs JavaScript in a separate V8 isolate for sandboxing.

```bash
pnpm add isolated-vm
```

**wasm-js bridging** - how WasixInstance delegates `node` commands to NodeProcess. see TEST_WASM_JS_BRIDGE.md for research.

**file-based IPC polling** ([test 18](scratch/wasmer-test/test18-fs-polling-ipc.ts), [rust shim](scratch/wasmer-node-shim/)):
proven approach for bridging WASM to host Node.js:

1. build a rust-based `node` shim (compiled to WASM) that:
   - writes args to `/ipc/request.txt`
   - polls for `/ipc/response.txt`
   - reads exit code + stdout and returns

2. host-side JavaScript:
   - polls Directory for `/ipc/request.txt`
   - when found, executes real `node` via child_process
   - writes result to `/ipc/response.txt`

3. package the shim with bash + coreutils in a .webc file

this enables shell scripts to call `node` since bash can spawn our custom node shim, which then bridges to real Node.js via file-based IPC. latency is ~200-500ms per call due to polling.

**custom WASM shell with native bridge imports** ([test 9](scratch/wasmer-test/test9-wasi-plus-custom.ts)):
alternative approach using direct WASM imports (lower latency but more complex):
- use Node.js native WASI (not @wasmer/sdk) with custom `bridge.*` imports
- WASM shell calls `bridge.spawn_node("script.js")` → JS handler → NodeProcess
- requires building a custom WASM binary in Rust that imports both WASI and bridge functions

## steps

1. implement VirtualMachine and SystemBridge with basic filesystem. VirtualMachine owns a SystemBridge that forwards to a dedicated folder on the host.

```ts
import { VirtualMachine } from "./vm";
import { SystemBridge } from "./system-bridge";
import fs from "fs";
import path from "path";
import os from "os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-test-"));

// SystemBridge can be used directly
const bridge = new SystemBridge(tmpDir);
bridge.writeFile("/direct.txt", "hello");
expect(fs.readFileSync(path.join(tmpDir, "direct.txt"), "utf8")).toBe("hello");

// VirtualMachine wraps SystemBridge
const vm = new VirtualMachine(tmpDir);
vm.writeFile("/foo.txt", "bar");
expect(vm.readFile("/foo.txt")).toBe("bar");
```

2. get basic isolates & bindings working using isolated-vm

```ts
import { NodeProcess } from "./node-process";

const proc = new NodeProcess();
const result = await proc.run(`module.exports = 1 + 1`);
expect(result).toBe(2);
```

3. impl nodejs require with polyfill for node stdlib

```ts
import { NodeProcess } from "./node-process";

const proc = new NodeProcess();
const result = await proc.run(`
  const path = require("path");
  module.exports = path.join("foo", "bar");
`);
expect(result).toBe("foo/bar");
```

4. get basic wasix shell working

```ts
import { WasixInstance } from "./wasix";

const wasix = new WasixInstance();
const result = await wasix.exec("echo hello");
expect(result.stdout).toBe("hello\n");
```

5. get wasix file system bindings working (test ls, cd, etc)

```ts
import { VirtualMachine } from "./vm";

const vm = new VirtualMachine(tmpDir);
vm.writeFile("/test.txt", "content");

const result = await vm.spawn("ls", ["/"]);
expect(result.stdout).toContain("test.txt");
```

6. implement package imports using the code in node_modules

```ts
import { VirtualMachine } from "./vm";
import { NodeProcess } from "./node-process";

const vm = new VirtualMachine(tmpDir);
// assume `pnpm add ms` was run in tmpDir on host
const proc = new NodeProcess(vm);
const result = await proc.run(`
  const ms = require("ms");
  module.exports = ms("1h");
`);
expect(result).toBe(3600000);
```

7. implement hybrid routing in VirtualMachine.spawn()

VirtualMachine.spawn() checks the command name and routes to the appropriate runtime:
- `node` → NodeProcess (run JS in isolated-vm)
- linux commands (ls, cat, echo, etc.) → WasixInstance

```ts
import { VirtualMachine } from "./vm";

const vm = new VirtualMachine(tmpDir);
vm.writeFile("/script.js", `console.log("hello from node")`);

// this routes to NodeProcess, not WASM
const result = await vm.spawn("node", ["/script.js"]);
expect(result.stdout).toBe("hello from node\n");

// this routes to WasixInstance
const lsResult = await vm.spawn("ls", ["/"]);
expect(lsResult.stdout).toContain("script.js");
```

**note:** `vm.spawn("sh", ["script-that-calls-node.sh"])` is supported via file-based IPC polling. the shell runs in WASM with a custom `node` shim that bridges to NodeProcess (see [test 18](scratch/wasmer-test/test18-fs-polling-ipc.ts) and [rust shim](scratch/wasmer-node-shim/)).

## future work

- terminal emulation
- get claude code cli working in this emulator
- emulate npm
- use node_modules instead of pulling packages from cdn
- native addon polyfills - npm packages with native C/C++ bindings won't work in isolated-vm. may need a polyfill registry mapping them to pure-JS alternatives (e.g. esbuild→esbuild-wasm, bcrypt→bcryptjs, sharp→sharp-wasm, sqlite3→sql.js)

