import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Get the fs module code that can be injected into an isolate.
 * This returns the compiled JavaScript code as a string wrapped in an IIFE.
 */
export function getFsModuleCode(): string {
  // Read the compiled bridge.js file (IIFE format)
  const bridgePath = path.join(__dirname, "..", "assets", "bridge.js");
  const code = fs.readFileSync(bridgePath, "utf8");

  // The compiled code creates a global `bridge` variable with the module exports
  // bridge = { default: fs, fs: fs }
  // We need to wrap it to return the default export (which is the fs module)
  return `(function() {
${code}
  return bridge.default;
})()`;
}

/**
 * The fs module code as a constant string.
 * Use this if you need the code at import time.
 */
export const FS_MODULE_CODE = getFsModuleCode();

export default FS_MODULE_CODE;
