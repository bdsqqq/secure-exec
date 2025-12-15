import type { SystemBridge } from "../system-bridge/index.js";

/**
 * Bundle a package from node_modules in the virtual filesystem
 * This is a simple implementation that loads single-file packages directly.
 * For complex packages with dependencies, a full bundler would be needed.
 */
export async function bundlePackage(
  packageName: string,
  bridge: SystemBridge
): Promise<string | null> {
  // Find and read the package's entry point
  const entryPath = await findPackageEntry(packageName, bridge);
  if (!entryPath) {
    return null;
  }

  try {
    const entryCode = await bridge.readFile(entryPath);

    // Wrap the code in an IIFE that sets up module.exports
    const wrappedCode = `(function() {
      var module = { exports: {} };
      var exports = module.exports;
      ${entryCode}
      return module.exports;
    })()`;

    return wrappedCode;
  } catch {
    return null;
  }
}

/**
 * Find the entry point path for a package
 */
async function findPackageEntry(
  packageName: string,
  bridge: SystemBridge
): Promise<string | null> {
  const pkgJsonPath = `/node_modules/${packageName}/package.json`;

  try {
    const pkgJsonContent = await bridge.readFile(pkgJsonPath);
    const pkgJson = JSON.parse(pkgJsonContent);

    // Try different entry point fields
    const entry =
      pkgJson.main || pkgJson.module || pkgJson.browser || "index.js";

    // Normalize the entry path
    const entryPath = entry.startsWith("./")
      ? `/node_modules/${packageName}/${entry.slice(2)}`
      : `/node_modules/${packageName}/${entry}`;

    return entryPath;
  } catch {
    // package.json not found, try index.js
    const indexPath = `/node_modules/${packageName}/index.js`;
    try {
      await bridge.readFile(indexPath);
      return indexPath;
    } catch {
      return null;
    }
  }
}
