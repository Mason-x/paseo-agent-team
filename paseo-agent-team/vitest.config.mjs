import { DEFAULT_HOOK_TIMEOUT_MS, DEFAULT_TEST_TIMEOUT_MS } from "./tests/setup/load-timeouts.ts";

const inheritedHome = process.env.PASEO_HOME ?? "";

export default {
  test: {
    setupFiles: ["./tests/setup/isolate-paseo-home.ts"],
    testTimeout: DEFAULT_TEST_TIMEOUT_MS,
    hookTimeout: DEFAULT_HOOK_TIMEOUT_MS,
    env: {
      PASEO_VITEST_INHERITED_HOME: inheritedHome,
    },
  },
};
