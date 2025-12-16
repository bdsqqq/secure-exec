// Bridge module entry point
// This file is compiled to a single JS bundle that gets injected into the isolate

import fs from "./fs.js";

// Export all bridge modules
export { fs };

// Make fs available as the default export for convenience
export default fs;
