# libsandbox

![libsandbox logo](./.github/media/sb-logo.svg)

**Run fast, secure, Linux-compatible sandboxes anywhere Node.js runs — no external providers or nested virtualization.**

By compiling Linux tools to WebAssembly (WASIX) and combining with a V8 Isolate accelerator for speeding up Node.js performance, libsandbox provides a sandboxed, Linux-compatible environment anywhere Node.js runs in two lines of code:

Useful for one-off code evals, coding agents, and dev servers.

## Features

- **Portable**: Runs anywhere Node.js runs (including Vercel Fluid Compute, Railway), does not require nested virtualization or Docker-in-Docker 
- **Incredibly Fast**: WebAssembly and V8 isolates provide near-native performance with less memory than microVMs
- **Secure**: Powered by WebAssembly & V8 isolates, using the same technology as Chromium and Cloudflare Workers
- **Compatible With Coding Agents**: Provides tools coding agents are trained to use heavily (e.g. `rg`, `sed`, `awk`, `git`), not best-effort re-implementations. Coding agents don't need to do anything special, it just works.

## Examples

```typescript
import { VM } from "libsandbox";
const vm = await VM.start();

// Shell
await vm.exec("bash", { interactive: true });

// Install NPM packages
await vm.exec("npm install -g @anthropic-ai/claude-code")

// Claude Code
await vm.exec("npm install -g @anthropic-ai/claude-code && claude -p 'build me a billion dollar saas, make no mistakes'", {
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    interactive: true,
});

// Open Code
await vm.exec("TODO", {
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    interactive: true,
});

// Git repos
await vm.exec("git clone https://github.com/...");

// Run dev servers
await vm.exec("next dev");

// Make network requests
await vm.exec("curl google.com");

// Python
await vm.exec("python3");

// Dynamically instally new packages
await vm.exec("wapm install rivet-dev/todo");

// TTY
// TODO
```

## Demo

[Try it in your browser ->](TODO)

Try it in your terminal:

```
npx -p @libsandbox/terminal
```

## Getting Started

### `libsandbox`

TODO

### `@libsandbox/sandboxed-node`

TODO

### Deploy & Scale with Rivet

TODO

## Usage

### Interactive Shells

TODO

### Installing Components At Runtime

TODO

### Adding Components

TODO

### Building Components

TODO

## Comparison

TODO: Architecture diagrams for each, and sort by light -> heavy

|       | microVM                      | Isolates & WASM                              | Docker/cgroup/bubblewarp/nsjail/etc | Full VMs |
| Cost  | Expensive           
| Self-hostable | No | Yes | Yes | No |
| Users | Daytona, E2B, Fly.io, Lambda | NanoSandbox, Chromium, Cloudflare Workers, Deno Deploy | TBD                   | EC2      |
| Secure | Yes | Yes | No | Yes |
| Coldstarts | Medium | Low | Low | High |
| Resource Packing | Poor (ballooning allocator) | Good | Good | Poor |
| Idle compute | Paying for expensive compute while idle | Costs almost nothing while idle | Costs almost nothing while idle | Paying for expensive compute while idle |
| Compatibility | Good | Good enough (has fallback) | Good | Great |
| Supports browser-based sandboxes | No | Coming soon | No | No |

## Technical Details

### Architecture

TODO

### Benchmarks

**Idle**

TODO

Measuring: idle memory, idle CPU

- Next.js dev server
- Vite dev server

**CPU-bound**

TODO

Measuring: idle memory, idle CPU

- Next.js build
- Vite build

### WebAssembly & WASIX

TODO

### V8 Accelerator for Node.js

The core of libsandbox is powered by WebAssembly (WASIX) in order to provide real Linux tools to a lightweight sandbox at near-native performance.

However, the biggest problem with using WebAssembly is that it cannot run Node.js. All JS runtimes compiled to WebAssembly are [unacceptably slow](TODO) compared to the V8's highly optimized JIT runtime.

The solution is to implement new system calls in WASIX that allow programs in the VM to spawn V8 isolates — this consists of the majority of the work in building & maintaining libsandbox. We then provide a `node` bridge program that will forward all stdin & signal to the V8 isolate and return all stdout/stderr/exit code back in to the VM. Processes in the virtual machine treat node as if it is another program without any issues.

Similarly, Node's `fs`, `child_process`, `net`, etc all work as if they are part of the same virtual machine. This enables complex programs like NPM that have many child process-, filesystem-, and network-related operations to work without modification.

A similar project named WebContainers attempted this by implementing a Linux-compatible machine in JavaScript. However, this layer was heavily faked and prone to inconsistencies in the behavior. Due to the heavy reliance on standard Linux tools with Claude Code and other coding agents, there's a wide range of toosl that need to be provided using their exact implementations -- not a JavaScript re-implementation.

### Node.js Sandbox

A core part of this project was building a sandbox for Node.js using V8 isolates in the `@libsandbox/sandboxed-node` package. This package is completely independent of WASIX and can be used separately with different projects by providing your own virtual file system, network, and IO.

This sandbox works by providing 2 sets of polyfills:

- **System bridge**: These polyfills for libraries like `fs`, `child_process`, and `net` bridge the Node.js calls to the VM
- **Isolated polyfill**: Polyfills for libraries such as `path` that don't depend on the host VM are provided by `node-stdlib-browser`

The project includes a test suite of checkign that popular packages and CLI tools from the Node.js ecosystem work without issue.

Future work could involve compiling the Node.js standard library to WebAssembly, similar to how WebContainers did this. However, this would likely impact bundle size and increase coldstarts.

### Security

TODO

TODO: Cloudflare Workers is the gold standard of using V8 isolates for isolated code execution at scale, so it helps to compare to them as a baseline.

### Limitation

**This is not attempting to replace existing microVM solutions.**

- Linux tools must be complied to WASIX, you cannot download arbitrary binaries (potential fix: leverage existing x86 -> WASM cross-compilers, akin to macOS Rosetta)
- Does not support apt and other mainstream package managers
- NPM packages that require native modules (planned fix), including:
    - esbuild
    - turbo
    - Biome
- Sandboxed Node & WASIX cannot reach each other's networking (planned fix)

## Future Work

- Browser support
- Bun support (TBD if possible)
- VS Code Server
- Publish WASIX patches for popular native libraries (esbuild, turbopack, etc)

## Other Tools

- [Wasmer SDK](TODO) Provides the core WASIX runtime. Consider using this if you don't need the V8 accelerator.

## License

Apache 2.0

