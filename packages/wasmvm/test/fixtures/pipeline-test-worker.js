/**
 * Test fixture worker for pipeline tests.
 *
 * Simulates command execution without real WASM.
 * Supports: echo, cat, uppercase, wc, fail, exit42, tee, writefile
 */
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (msg) => {
  const { command, args = [], stdin } = msg;
  const encoder = new TextEncoder();

  let exitCode = 0;
  let stdout = new Uint8Array(0);
  let stderr = new Uint8Array(0);
  let vfsChanges = [];

  switch (command) {
    case 'echo': {
      // echo args joined by space, with trailing newline
      const text = args.join(' ') + '\n';
      stdout = encoder.encode(text);
      break;
    }
    case 'cat': {
      // Pass stdin through as stdout
      if (stdin instanceof Uint8Array) {
        stdout = stdin;
      } else if (typeof stdin === 'string') {
        stdout = encoder.encode(stdin);
      } else {
        stdout = new Uint8Array(0);
      }
      break;
    }
    case 'uppercase': {
      // Convert stdin to uppercase
      let text2 = '';
      if (stdin instanceof Uint8Array) {
        text2 = new TextDecoder().decode(stdin);
      } else if (typeof stdin === 'string') {
        text2 = stdin;
      }
      stdout = encoder.encode(text2.toUpperCase());
      break;
    }
    case 'wc': {
      // Count bytes of stdin (like wc -c)
      let len = 0;
      if (stdin instanceof Uint8Array) {
        len = stdin.length;
      } else if (typeof stdin === 'string') {
        len = encoder.encode(stdin).length;
      }
      stdout = encoder.encode(len.toString() + '\n');
      break;
    }
    case 'fail': {
      exitCode = 1;
      stderr = encoder.encode('fail: command failed\n');
      break;
    }
    case 'exit42': {
      exitCode = 42;
      stderr = encoder.encode('exit42: exiting with code 42\n');
      break;
    }
    case 'tee': {
      // tee <filepath> — write stdin to a VFS file and pass stdin through as stdout
      const path = args[0] || '/tmp/tee-output';
      let data = new Uint8Array(0);
      if (stdin instanceof Uint8Array) {
        data = stdin;
        stdout = stdin;
      } else if (typeof stdin === 'string') {
        data = encoder.encode(stdin);
        stdout = data;
      }
      vfsChanges = [{ type: 'file', path, data }];
      break;
    }
    case 'writefile': {
      // writefile <filepath> <content> — write content to a VFS file, no stdout
      const filePath = args[0] || '/tmp/writefile-output';
      const content = args.slice(1).join(' ');
      vfsChanges = [{ type: 'file', path: filePath, data: encoder.encode(content) }];
      break;
    }
    default: {
      exitCode = 127;
      stderr = encoder.encode(`${command}: command not found\n`);
      break;
    }
  }

  parentPort.postMessage({
    exitCode,
    stdout,
    stderr,
    vfsChanges,
  });
});
