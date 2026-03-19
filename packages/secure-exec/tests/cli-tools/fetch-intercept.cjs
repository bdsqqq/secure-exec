/**
 * Node.js preload script that redirects Anthropic API calls to a mock server.
 *
 * Usage: NODE_OPTIONS="-r <path>/fetch-intercept.cjs" pi --print ...
 * Set MOCK_LLM_URL=http://127.0.0.1:<port> to redirect.
 */
'use strict';

const mockUrl = process.env.MOCK_LLM_URL;
if (mockUrl) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    let url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url && url.includes('api.anthropic.com')) {
      const newUrl = url.replace(/https?:\/\/api\.anthropic\.com/, mockUrl);
      if (typeof input === 'string') {
        input = newUrl;
      } else if (input instanceof URL) {
        input = new URL(newUrl);
      } else {
        input = new Request(newUrl, input);
      }
    }
    return origFetch.call(this, input, init);
  };
}
