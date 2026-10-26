import type { RuntimeCapabilities } from "./seat-plan";

/** Shared by launch preview and design planning so both hashes see the same capabilities. */
export const LAUNCH_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  onDemand: false,
  expansion: false,
  collaboration: false,
};
