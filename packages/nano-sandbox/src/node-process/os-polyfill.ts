/**
 * OS module polyfill code to be injected into isolated-vm context.
 * This provides comprehensive Node.js os module emulation for sandbox compatibility.
 */

export interface OSConfig {
  platform?: string;
  arch?: string;
  type?: string;
  release?: string;
  version?: string;
  homedir?: string;
  tmpdir?: string;
  hostname?: string;
}

/**
 * Generate the os polyfill code to inject into the isolate.
 * This code runs inside the isolated VM context.
 */
export function generateOSPolyfill(config: OSConfig = {}): string {
  const platform = config.platform ?? "linux";
  const arch = config.arch ?? "x64";
  const type = config.type ?? "Linux";
  const release = config.release ?? "5.15.0";
  const version = config.version ?? "#1 SMP";
  const homedir = config.homedir ?? "/root";
  const tmpdir = config.tmpdir ?? "/tmp";
  const hostname = config.hostname ?? "sandbox";

  return `
(function() {
  const os = {
    // Platform information
    platform: function() { return ${JSON.stringify(platform)}; },
    arch: function() { return ${JSON.stringify(arch)}; },
    type: function() { return ${JSON.stringify(type)}; },
    release: function() { return ${JSON.stringify(release)}; },
    version: function() { return ${JSON.stringify(version)}; },

    // Directory information
    homedir: function() { return ${JSON.stringify(homedir)}; },
    tmpdir: function() { return ${JSON.stringify(tmpdir)}; },

    // System information
    hostname: function() { return ${JSON.stringify(hostname)}; },

    // User information
    userInfo: function(options) {
      return {
        username: 'root',
        uid: 0,
        gid: 0,
        shell: '/bin/bash',
        homedir: ${JSON.stringify(homedir)}
      };
    },

    // CPU information
    cpus: function() {
      return [{
        model: 'Virtual CPU',
        speed: 2000,
        times: {
          user: 100000,
          nice: 0,
          sys: 50000,
          idle: 800000,
          irq: 0
        }
      }];
    },

    // Memory information
    totalmem: function() { return 1073741824; }, // 1GB
    freemem: function() { return 536870912; },   // 512MB

    // System load
    loadavg: function() { return [0.1, 0.1, 0.1]; },

    // System uptime
    uptime: function() { return 3600; }, // 1 hour

    // Network interfaces (empty - not supported)
    networkInterfaces: function() { return {}; },

    // System endianness
    endianness: function() { return 'LE'; },

    // Line endings
    EOL: '\\n',

    // Dev null path
    devNull: '/dev/null',

    // Machine type (same as arch for our purposes)
    machine: function() { return ${JSON.stringify(arch)}; },

    // Priority constants
    constants: {
      signals: {
        SIGHUP: 1,
        SIGINT: 2,
        SIGQUIT: 3,
        SIGILL: 4,
        SIGTRAP: 5,
        SIGABRT: 6,
        SIGIOT: 6,
        SIGBUS: 7,
        SIGFPE: 8,
        SIGKILL: 9,
        SIGUSR1: 10,
        SIGSEGV: 11,
        SIGUSR2: 12,
        SIGPIPE: 13,
        SIGALRM: 14,
        SIGTERM: 15,
        SIGSTKFLT: 16,
        SIGCHLD: 17,
        SIGCONT: 18,
        SIGSTOP: 19,
        SIGTSTP: 20,
        SIGTTIN: 21,
        SIGTTOU: 22,
        SIGURG: 23,
        SIGXCPU: 24,
        SIGXFSZ: 25,
        SIGVTALRM: 26,
        SIGPROF: 27,
        SIGWINCH: 28,
        SIGIO: 29,
        SIGPOLL: 29,
        SIGPWR: 30,
        SIGSYS: 31,
        SIGUNUSED: 31
      },
      errno: {
        E2BIG: 7,
        EACCES: 13,
        EADDRINUSE: 98,
        EADDRNOTAVAIL: 99,
        EAFNOSUPPORT: 97,
        EAGAIN: 11,
        EALREADY: 114,
        EBADF: 9,
        EBADMSG: 74,
        EBUSY: 16,
        ECANCELED: 125,
        ECHILD: 10,
        ECONNABORTED: 103,
        ECONNREFUSED: 111,
        ECONNRESET: 104,
        EDEADLK: 35,
        EDESTADDRREQ: 89,
        EDOM: 33,
        EDQUOT: 122,
        EEXIST: 17,
        EFAULT: 14,
        EFBIG: 27,
        EHOSTUNREACH: 113,
        EIDRM: 43,
        EILSEQ: 84,
        EINPROGRESS: 115,
        EINTR: 4,
        EINVAL: 22,
        EIO: 5,
        EISCONN: 106,
        EISDIR: 21,
        ELOOP: 40,
        EMFILE: 24,
        EMLINK: 31,
        EMSGSIZE: 90,
        EMULTIHOP: 72,
        ENAMETOOLONG: 36,
        ENETDOWN: 100,
        ENETRESET: 102,
        ENETUNREACH: 101,
        ENFILE: 23,
        ENOBUFS: 105,
        ENODATA: 61,
        ENODEV: 19,
        ENOENT: 2,
        ENOEXEC: 8,
        ENOLCK: 37,
        ENOLINK: 67,
        ENOMEM: 12,
        ENOMSG: 42,
        ENOPROTOOPT: 92,
        ENOSPC: 28,
        ENOSR: 63,
        ENOSTR: 60,
        ENOSYS: 38,
        ENOTCONN: 107,
        ENOTDIR: 20,
        ENOTEMPTY: 39,
        ENOTSOCK: 88,
        ENOTSUP: 95,
        ENOTTY: 25,
        ENXIO: 6,
        EOPNOTSUPP: 95,
        EOVERFLOW: 75,
        EPERM: 1,
        EPIPE: 32,
        EPROTO: 71,
        EPROTONOSUPPORT: 93,
        EPROTOTYPE: 91,
        ERANGE: 34,
        EROFS: 30,
        ESPIPE: 29,
        ESRCH: 3,
        ESTALE: 116,
        ETIME: 62,
        ETIMEDOUT: 110,
        ETXTBSY: 26,
        EWOULDBLOCK: 11,
        EXDEV: 18
      },
      priority: {
        PRIORITY_LOW: 19,
        PRIORITY_BELOW_NORMAL: 10,
        PRIORITY_NORMAL: 0,
        PRIORITY_ABOVE_NORMAL: -7,
        PRIORITY_HIGH: -14,
        PRIORITY_HIGHEST: -20
      },
      dlopen: {
        RTLD_LAZY: 1,
        RTLD_NOW: 2,
        RTLD_GLOBAL: 256,
        RTLD_LOCAL: 0
      }
    },

    // Priority getters/setters (stubs)
    getPriority: function(pid) { return 0; },
    setPriority: function(pid, priority) {
      if (typeof pid === 'number' && priority === undefined) {
        // setPriority(priority) form
        return;
      }
      // setPriority(pid, priority) form
    },

    // Temp directory function (aliases tmpdir)
    tmpDir: function() { return ${JSON.stringify(tmpdir)}; },

    // Parallelism hint (returns 1 for single CPU)
    availableParallelism: function() { return 1; }
  };

  // Export to global for require() to use
  globalThis._osModule = os;

  return os;
})();
`;
}
