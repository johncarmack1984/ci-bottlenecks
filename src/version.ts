import pkg from "../package.json";

// Single source of truth for the tool version: package.json. The bundler
// inlines it, so dist stays self-contained.
export const VERSION: string = pkg.version;
