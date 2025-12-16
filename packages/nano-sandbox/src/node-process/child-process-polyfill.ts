/**
 * Child process polyfill code to be injected into isolated-vm context.
 * This provides Node.js child_process module emulation that bridges to WasixInstance.
 *
 * TODO: Move child_process to its own module to be built separately.
 */

/**
 * Generate the child_process polyfill code to inject into the isolate.
 * This code runs inside the isolated VM context.
 *
 * The polyfill requires these References to be set up:
 * - _childProcessExecRaw: (command: string) => Promise<string> (JSON-encoded result)
 * - _childProcessSpawnRaw: (command: string, args: string[]) => Promise<string> (JSON-encoded result)
 */
export function generateChildProcessPolyfill(): string {
  return `
(function() {
  // ChildProcess class - EventEmitter-like
  class ChildProcess {
    constructor() {
      this._listeners = {};
      this._onceListeners = {};
      this.pid = Math.floor(Math.random() * 10000) + 1000;
      this.killed = false;
      this.exitCode = null;
      this.signalCode = null;
      this.connected = false;
      this.spawnfile = '';
      this.spawnargs = [];

      // Create stream stubs
      this.stdin = {
        writable: true,
        _buffer: [],
        write(data) {
          this._buffer.push(data);
          return true;
        },
        end() { this.writable = false; },
        on() { return this; },
        once() { return this; },
        emit() { return false; }
      };

      this.stdout = {
        readable: true,
        _data: '',
        on(event, listener) {
          if (!this._listeners) this._listeners = {};
          if (!this._listeners[event]) this._listeners[event] = [];
          this._listeners[event].push(listener);
          return this;
        },
        once(event, listener) {
          if (!this._onceListeners) this._onceListeners = {};
          if (!this._onceListeners[event]) this._onceListeners[event] = [];
          this._onceListeners[event].push(listener);
          return this;
        },
        emit(event, ...args) {
          if (this._listeners && this._listeners[event]) {
            this._listeners[event].forEach(fn => fn(...args));
          }
          if (this._onceListeners && this._onceListeners[event]) {
            this._onceListeners[event].forEach(fn => fn(...args));
            this._onceListeners[event] = [];
          }
          return true;
        },
        read() { return null; },
        setEncoding() { return this; },
        pipe(dest) { return dest; }
      };

      this.stderr = {
        readable: true,
        _data: '',
        on(event, listener) {
          if (!this._listeners) this._listeners = {};
          if (!this._listeners[event]) this._listeners[event] = [];
          this._listeners[event].push(listener);
          return this;
        },
        once(event, listener) {
          if (!this._onceListeners) this._onceListeners = {};
          if (!this._onceListeners[event]) this._onceListeners[event] = [];
          this._onceListeners[event].push(listener);
          return this;
        },
        emit(event, ...args) {
          if (this._listeners && this._listeners[event]) {
            this._listeners[event].forEach(fn => fn(...args));
          }
          if (this._onceListeners && this._onceListeners[event]) {
            this._onceListeners[event].forEach(fn => fn(...args));
            this._onceListeners[event] = [];
          }
          return true;
        },
        read() { return null; },
        setEncoding() { return this; },
        pipe(dest) { return dest; }
      };

      this.stdio = [this.stdin, this.stdout, this.stderr];
    }

    on(event, listener) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(listener);
      return this;
    }

    once(event, listener) {
      if (!this._onceListeners[event]) this._onceListeners[event] = [];
      this._onceListeners[event].push(listener);
      return this;
    }

    off(event, listener) {
      if (this._listeners[event]) {
        const idx = this._listeners[event].indexOf(listener);
        if (idx !== -1) this._listeners[event].splice(idx, 1);
      }
      return this;
    }

    removeListener(event, listener) {
      return this.off(event, listener);
    }

    emit(event, ...args) {
      let handled = false;
      if (this._listeners[event]) {
        this._listeners[event].forEach(fn => { fn(...args); handled = true; });
      }
      if (this._onceListeners[event]) {
        this._onceListeners[event].forEach(fn => { fn(...args); handled = true; });
        this._onceListeners[event] = [];
      }
      return handled;
    }

    kill(signal) {
      this.killed = true;
      this.signalCode = signal || 'SIGTERM';
      return true;
    }

    ref() { return this; }
    unref() { return this; }
    disconnect() { this.connected = false; }

    _complete(stdout, stderr, code) {
      this.exitCode = code;

      // Emit data events for stdout/stderr as single chunks
      if (stdout) {
        const buf = typeof Buffer !== 'undefined' ? Buffer.from(stdout) : stdout;
        this.stdout.emit('data', buf);
      }
      if (stderr) {
        const buf = typeof Buffer !== 'undefined' ? Buffer.from(stderr) : stderr;
        this.stderr.emit('data', buf);
      }

      // Emit end events
      this.stdout.emit('end');
      this.stderr.emit('end');

      // Emit close event (code, signal)
      this.emit('close', code, this.signalCode);

      // Emit exit event
      this.emit('exit', code, this.signalCode);
    }
  }

  // exec - execute shell command, callback when done
  function exec(command, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    options = options || {};

    const child = new ChildProcess();
    child.spawnargs = ['bash', '-c', command];
    child.spawnfile = 'bash';

    // Execute asynchronously via host bridge
    (async () => {
      try {
        const jsonResult = await _childProcessExecRaw.apply(undefined, [command], { result: { promise: true } });
        const result = JSON.parse(jsonResult);
        const stdout = result.stdout || '';
        const stderr = result.stderr || '';
        const code = result.code || 0;

        child._complete(stdout, stderr, code);

        if (callback) {
          if (code !== 0) {
            const err = new Error('Command failed: ' + command);
            err.code = code;
            err.killed = false;
            err.signal = null;
            err.cmd = command;
            err.stdout = stdout;
            err.stderr = stderr;
            callback(err, stdout, stderr);
          } else {
            callback(null, stdout, stderr);
          }
        }
      } catch (err) {
        child._complete('', err.message, 1);
        if (callback) {
          const error = err instanceof Error ? err : new Error(String(err));
          error.code = 1;
          error.stdout = '';
          error.stderr = err.message || String(err);
          callback(error, '', error.stderr);
        }
      }
    })();

    return child;
  }

  // execSync - synchronous shell execution
  function execSync(command, options) {
    options = options || {};

    // Use synchronous bridge call - result is JSON string
    const jsonResult = _childProcessExecRaw.applySyncPromise(undefined, [command]);
    const result = JSON.parse(jsonResult);

    if (result.code !== 0) {
      const err = new Error('Command failed: ' + command);
      err.status = result.code;
      err.stdout = result.stdout;
      err.stderr = result.stderr;
      err.output = [null, result.stdout, result.stderr];
      throw err;
    }

    if (options.encoding === 'buffer' || !options.encoding) {
      return typeof Buffer !== 'undefined' ? Buffer.from(result.stdout) : result.stdout;
    }
    return result.stdout;
  }

  // spawn - spawn a command with streaming
  function spawn(command, args, options) {
    if (!Array.isArray(args)) {
      options = args;
      args = [];
    }
    options = options || {};

    const child = new ChildProcess();
    child.spawnfile = command;
    child.spawnargs = [command, ...args];

    // Check if it's a shell command
    const useShell = options.shell || false;

    // Execute asynchronously
    (async () => {
      try {
        let jsonResult;
        if (useShell || command === 'bash' || command === 'sh') {
          // Use shell execution
          const fullCmd = [command, ...args].join(' ');
          jsonResult = await _childProcessExecRaw.apply(undefined, [fullCmd], { result: { promise: true } });
        } else {
          // Use spawn - args passed as JSON string for transferability
          jsonResult = await _childProcessSpawnRaw.apply(undefined, [command, JSON.stringify(args)], { result: { promise: true } });
        }
        const result = JSON.parse(jsonResult);

        child._complete(result.stdout || '', result.stderr || '', result.code || 0);
      } catch (err) {
        child._complete('', err.message, 1);
        child.emit('error', err);
      }
    })();

    return child;
  }

  // spawnSync - synchronous spawn
  function spawnSync(command, args, options) {
    if (!Array.isArray(args)) {
      options = args;
      args = [];
    }
    options = options || {};

    try {
      // Args passed as JSON string for transferability
      const jsonResult = _childProcessSpawnRaw.applySyncPromise(undefined, [command, JSON.stringify(args)]);
      const result = JSON.parse(jsonResult);

      return {
        pid: Math.floor(Math.random() * 10000) + 1000,
        output: [null, result.stdout, result.stderr],
        stdout: typeof Buffer !== 'undefined' ? Buffer.from(result.stdout) : result.stdout,
        stderr: typeof Buffer !== 'undefined' ? Buffer.from(result.stderr) : result.stderr,
        status: result.code,
        signal: null,
        error: undefined
      };
    } catch (err) {
      return {
        pid: 0,
        output: [null, '', err.message],
        stdout: typeof Buffer !== 'undefined' ? Buffer.from('') : '',
        stderr: typeof Buffer !== 'undefined' ? Buffer.from(err.message) : err.message,
        status: 1,
        signal: null,
        error: err
      };
    }
  }

  // execFile - execute a file directly
  function execFile(file, args, options, callback) {
    if (typeof args === 'function') {
      callback = args;
      args = [];
      options = {};
    } else if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    // execFile is like spawn but with callback
    const child = spawn(file, args, options);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (callback) {
        if (code !== 0) {
          const err = new Error('Command failed: ' + file);
          err.code = code;
          err.stdout = stdout;
          err.stderr = stderr;
          callback(err, stdout, stderr);
        } else {
          callback(null, stdout, stderr);
        }
      }
    });

    child.on('error', (err) => {
      if (callback) {
        callback(err, stdout, stderr);
      }
    });

    return child;
  }

  // execFileSync
  function execFileSync(file, args, options) {
    if (!Array.isArray(args)) {
      options = args;
      args = [];
    }
    options = options || {};

    const result = spawnSync(file, args, options);

    if (result.status !== 0) {
      const err = new Error('Command failed: ' + file);
      err.status = result.status;
      err.stdout = result.stdout;
      err.stderr = result.stderr;
      throw err;
    }

    if (options.encoding === 'buffer' || !options.encoding) {
      return result.stdout;
    }
    return result.stdout.toString ? result.stdout.toString(options.encoding) : result.stdout;
  }

  // fork - spawn a node process with IPC
  function fork(modulePath, args, options) {
    if (!Array.isArray(args)) {
      options = args;
      args = [];
    }
    options = options || {};

    // Fork executes a node script - we use spawn with node
    const child = spawn('node', [modulePath, ...args], {
      ...options,
      stdio: options.stdio || 'pipe'
    });

    // Add IPC-like methods (stubs)
    child.send = function(message, sendHandle, options, callback) {
      if (typeof sendHandle === 'function') {
        callback = sendHandle;
        sendHandle = undefined;
      }
      if (callback) callback(null);
      return true;
    };

    child.connected = true;

    return child;
  }

  // Create the child_process module
  const childProcess = {
    ChildProcess,
    exec,
    execSync,
    spawn,
    spawnSync,
    execFile,
    execFileSync,
    fork
  };

  // Export to global for require() to use
  globalThis._childProcessModule = childProcess;

  return childProcess;
})();
`;
}
