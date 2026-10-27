const inheritedHome = process.env.PASEO_HOME ?? "";

export default {
  test: {
    setupFiles: ["./tests/setup/isolate-paseo-home.ts"],
    env: {
      PASEO_VITEST_INHERITED_HOME: inheritedHome,
    },
  },
};
