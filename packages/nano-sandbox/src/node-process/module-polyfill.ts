/**
 * Module polyfill code to be injected into isolated-vm context.
 * This provides module.createRequire and other module utilities for npm compatibility.
 */

/**
 * Generate the module polyfill code to inject into the isolate.
 * This code runs inside the isolated VM context.
 *
 * Requires the _requireFrom function to be set up by setupRequire().
 */
export function generateModulePolyfill(): string {
  return `
(function() {
  // Path utilities for module resolution
  function _pathDirname(p) {
    const lastSlash = p.lastIndexOf('/');
    if (lastSlash === -1) return '.';
    if (lastSlash === 0) return '/';
    return p.slice(0, lastSlash);
  }

  function _pathResolve(...segments) {
    let resolvedPath = '';
    let resolvedAbsolute = false;

    for (let i = segments.length - 1; i >= 0 && !resolvedAbsolute; i--) {
      const segment = segments[i];
      if (!segment) continue;

      resolvedPath = segment + '/' + resolvedPath;
      resolvedAbsolute = segment.charAt(0) === '/';
    }

    // Normalize the path
    const parts = resolvedPath.split('/').filter(Boolean);
    const result = [];
    for (const part of parts) {
      if (part === '..') {
        result.pop();
      } else if (part !== '.') {
        result.push(part);
      }
    }

    return (resolvedAbsolute ? '/' : '') + result.join('/') || '.';
  }

  function _parseFileUrl(url) {
    // Handle file:// URLs
    if (url.startsWith('file://')) {
      // Remove file:// prefix
      let path = url.slice(7);
      // Handle file:///path on Unix (3 slashes = absolute path)
      if (path.startsWith('/')) {
        return path;
      }
      // Handle file://host/path (rare, treat host as empty)
      return '/' + path;
    }
    return url;
  }

  /**
   * Create a require function that resolves relative to the given filename.
   * This mimics Node.js's module.createRequire(filename).
   */
  function createRequire(filename) {
    if (typeof filename !== 'string') {
      throw new TypeError('filename must be a string or URL');
    }

    // Parse file:// URLs
    const filepath = _parseFileUrl(filename);
    const dirname = _pathDirname(filepath);

    // Create a require function bound to this directory
    const requireFn = function(request) {
      return _requireFrom(request, dirname);
    };

    // Add require.resolve
    requireFn.resolve = function(request, options) {
      // options.paths is not fully supported, but we accept it for compatibility
      const resolved = _resolveModule.applySyncPromise(undefined, [request, dirname]);
      if (resolved === null) {
        const err = new Error("Cannot find module '" + request + "'");
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      return resolved;
    };

    // Add require.resolve.paths (stub - returns null for built-ins)
    requireFn.resolve.paths = function(request) {
      // For built-in modules, return null
      const builtins = ['fs', 'path', 'os', 'events', 'util', 'http', 'https', 'dns', 'child_process', 'stream', 'buffer', 'url', 'querystring', 'crypto', 'zlib', 'assert', 'tty', 'net', 'tls'];
      if (builtins.includes(request) || request.startsWith('node:')) {
        return null;
      }
      // For relative paths, return array starting from dirname
      if (request.startsWith('./') || request.startsWith('../') || request.startsWith('/')) {
        return [dirname];
      }
      // For bare specifiers, return node_modules search paths
      const paths = [];
      let current = dirname;
      while (current !== '/') {
        paths.push(current + '/node_modules');
        current = _pathDirname(current);
      }
      paths.push('/node_modules');
      return paths;
    };

    // Add require.cache reference to global module cache
    requireFn.cache = _moduleCache;

    // Add require.main (null for dynamically created require)
    requireFn.main = undefined;

    // Add require.extensions (deprecated but still used by some tools)
    requireFn.extensions = {
      '.js': function(module, filename) {
        // This is a stub - actual loading is handled by our require implementation
      },
      '.json': function(module, filename) {
        // JSON loading stub
      },
      '.node': function(module, filename) {
        throw new Error('.node extensions are not supported in sandbox');
      }
    };

    return requireFn;
  }

  // Module object with createRequire and other utilities
  const moduleModule = {
    createRequire: createRequire,

    // Module._extensions (deprecated alias)
    _extensions: {
      '.js': function() {},
      '.json': function() {},
      '.node': function() { throw new Error('.node extensions are not supported'); }
    },

    // Module._cache reference
    _cache: _moduleCache,

    // Built-in module list
    builtinModules: [
      'assert', 'buffer', 'child_process', 'crypto', 'dns', 'events',
      'fs', 'http', 'https', 'net', 'os', 'path', 'querystring',
      'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'zlib'
    ],

    // isBuiltin check
    isBuiltin: function(moduleName) {
      const name = moduleName.replace(/^node:/, '');
      return moduleModule.builtinModules.includes(name);
    },

    // Module._resolveFilename (internal but sometimes used)
    _resolveFilename: function(request, parent, isMain, options) {
      const parentDir = parent && parent.dirname ? parent.dirname : '/';
      const resolved = _resolveModule.applySyncPromise(undefined, [request, parentDir]);
      if (resolved === null) {
        const err = new Error("Cannot find module '" + request + "'");
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      return resolved;
    },

    // syncBuiltinESMExports (stub for ESM interop)
    syncBuiltinESMExports: function() {
      // No-op in our environment
    },

    // findSourceMap (stub)
    findSourceMap: function(path) {
      return undefined;
    },

    // SourceMap class (stub)
    SourceMap: class SourceMap {
      constructor(payload) {
        this.payload = payload;
      }
      get payload() { return this._payload; }
      set payload(value) { this._payload = value; }
      findEntry(line, column) { return {}; }
    }
  };

  // Export to global for require() to use
  globalThis._moduleModule = moduleModule;

  return moduleModule;
})();
`;
}
