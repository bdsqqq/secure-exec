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

```ts
const vm = new VirtualMachine();
await vm.loadFromHost("/path/to/local/fs");
const output = await vm.spawn("ls", ["/"]);
console.log('output', output.stdout, output.stderr, output.code)
```

**goal** - run node scripts, linux commands, and shell scripts that call node:

```ts
const vm = new VirtualMachine();
await vm.loadFromHost("/path/to/local/fs");

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

// shell script that calls node - bash runs in WASM, node bridges via IPC
vm.writeFile("/test.sh", `#!/bin/bash
echo "starting"
node /script.js
echo "done"
`);
const shResult = await vm.spawn("bash", ["/test.sh"]);
console.log(shResult.stdout); // "starting\n1 hour in ms: 3600000\ndone"
```

## components

### virtual machine

orchestrates WasixInstance and NodeProcess. provides the main `spawn()` API that routes commands to the appropriate runtime. owns the SystemBridge instance that both runtimes share.

### system bridge

shared layer for filesystem, network, and other system resources. wraps the shared Directory instance.

**filesystem architecture:**
- Directory (from @wasmer/sdk) is the source of truth - an in-memory filesystem shared between WASM and JS
- SystemBridge wraps Directory, not host fs
- NodeProcess: fs polyfill → SystemBridge → Directory
- WasixInstance: uses same Directory directly
- both runtimes see the same files with full read/write
- host fs path passed to VirtualMachine is for initial loading / optional persisting, not live storage

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

uses @wasmer/sdk to run Linux commands. loads node-shim.webc package which bundles bash, coreutils, and the custom node shim for IPC bridging. see [test18-fs-polling-ipc.ts](scratch/wasmer-test/test18-fs-polling-ipc.ts) for the proven approach.

### node shim

a rust-compiled WASM binary ([source](scratch/wasmer-node-shim/)) that acts as a `node` command within the WASM environment. uses file-based IPC polling to bridge WASM to host Node.js (see [test18-fs-polling-ipc.ts](scratch/wasmer-test/test18-fs-polling-ipc.ts) for proven approach).

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

**file-based IPC polling** - used by the node shim to bridge WASM to host Node.js ([test 18](scratch/wasmer-test/test18-fs-polling-ipc.ts), [rust shim](scratch/wasmer-node-shim/)):

1. node shim (WASM) writes args to `/ipc/request.txt`
2. node shim polls for `/ipc/response.txt`
3. host-side JS (WasixInstance) polls Directory, finds request
4. host executes real `node` via NodeProcess
5. host writes exit code + stdout to `/ipc/response.txt`
6. node shim reads response, prints stdout, exits

this enables shell scripts to call `node` since bash can spawn our custom node shim. latency is ~200-500ms per call due to polling.

## steps

1. get basic isolates & bindings working using isolated-vm

```ts
import { NodeProcess } from "./node-process";

const proc = new NodeProcess();
const result = await proc.run(`module.exports = 1 + 1`);
expect(result).toBe(2);
```

2. impl nodejs require with polyfill for node stdlib

```ts
import { NodeProcess } from "./node-process";

const proc = new NodeProcess();
const result = await proc.run(`
  const path = require("path");
  module.exports = path.join("foo", "bar");
`);
expect(result).toBe("foo/bar");
```

3. implement VirtualMachine and SystemBridge with basic filesystem. SystemBridge wraps the shared Directory instance.

```ts
import { VirtualMachine } from "./vm";
import { SystemBridge } from "./system-bridge";
import { Directory } from "@wasmer/sdk";

// SystemBridge wraps Directory
const dir = new Directory();
const bridge = new SystemBridge(dir);
bridge.writeFile("/direct.txt", "hello");
expect(bridge.readFile("/direct.txt")).toBe("hello");

// VirtualMachine wraps SystemBridge
const vm = new VirtualMachine();
vm.writeFile("/foo.txt", "bar");
expect(vm.readFile("/foo.txt")).toBe("bar");
```

4. implement host fs loading layer

Copy files from host filesystem into Directory on init. This is how node_modules and other host files become available.

```ts
import { VirtualMachine } from "./vm";

// loadFromHost recursively copies host directory into Directory
const vm = new VirtualMachine();
await vm.loadFromHost("/path/to/project"); // copies into Directory

// now node_modules are available in Directory
expect(vm.readFile("/node_modules/ms/package.json")).toContain("ms");
```

5. get basic wasix shell working

```ts
import { WasixInstance } from "./wasix";

const wasix = new WasixInstance();
const result = await wasix.exec("echo hello");
expect(result.stdout).toBe("hello\n");
```

6. get wasix file system bindings working (test ls, cd, etc)

```ts
import { VirtualMachine } from "./vm";

const vm = new VirtualMachine();
vm.writeFile("/test.txt", "content");

const result = await vm.spawn("ls", ["/"]);
expect(result.stdout).toContain("test.txt");
```

7. integrate node shim with WasixInstance

WasixInstance loads the pre-built node-shim.webc and runs an IPC polling loop during exec() to handle node requests from WASM.

```ts
import { WasixInstance } from "./wasix";

const wasix = new WasixInstance(systemBridge);

// bash calls node, which triggers IPC:
// 1. node shim writes args to /ipc/request.txt
// 2. WasixInstance polls Directory, finds request
// 3. WasixInstance calls NodeProcess to run real node
// 4. WasixInstance writes result to /ipc/response.txt
// 5. node shim reads response, prints stdout, exits
const result = await wasix.exec("bash -c 'node -e \"console.log(2+2)\"'");
expect(result.stdout).toContain("4");
```

8. implement package imports using the code in node_modules

NodeProcess resolves require() calls against node_modules in Directory (loaded from host in step 4).

```ts
import { VirtualMachine } from "./vm";
import { NodeProcess } from "./node-process";

const vm = new VirtualMachine();
await vm.loadFromHost("/path/to/project"); // has node_modules with ms installed

const proc = new NodeProcess(vm);
const result = await proc.run(`
  const ms = require("ms");
  module.exports = ms("1h");
`);
expect(result).toBe(3600000);
```

9. implement hybrid routing in VirtualMachine.spawn()

VirtualMachine.spawn() checks the command name and routes to the appropriate runtime:
- `node` → NodeProcess (run JS in isolated-vm)
- linux commands (ls, cat, bash, etc.) → WasixInstance (loads [node shim .webc](scratch/wasmer-node-shim/))

```ts
import { VirtualMachine } from "./vm";

const vm = new VirtualMachine();
await vm.loadFromHost("/path/to/project");
vm.writeFile("/script.js", `console.log("hello from node")`);

// this routes to NodeProcess, not WASM
const result = await vm.spawn("node", ["/script.js"]);
expect(result.stdout).toBe("hello from node\n");

// this routes to WasixInstance
const lsResult = await vm.spawn("ls", ["/"]);
expect(lsResult.stdout).toContain("script.js");

// shell script that calls node - bash runs in WASM, node bridges to NodeProcess via IPC
vm.writeFile("/test.sh", `#!/bin/bash
echo "starting"
node /script.js
echo "done"
`);
const shResult = await vm.spawn("bash", ["/test.sh"]);
expect(shResult.stdout).toContain("hello from node");
```

## future work

- terminal emulation
- get claude code cli working in this emulator
- emulate npm
- native addon polyfills - npm packages with native C/C++ bindings won't work in isolated-vm. may need a polyfill registry mapping them to pure-JS alternatives (e.g. esbuild→esbuild-wasm, bcrypt→bcryptjs, sharp→sharp-wasm, sqlite3→sql.js)

