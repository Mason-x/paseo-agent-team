// Compiles the plugin with the Paseo host's own plugin compiler — the code path the daemon runs
// on load and reload — then evaluates both bundles against recording fakes. Module-boundary,
// manifest, and bundling errors surface here instead of on the next daemon restart.
//
// Usage: node scripts/verify-host-compile.mjs
// Checks against the @getpaseo/server version installed with @getpaseo/cli.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const serverRoot = path.join(root, "node_modules", "@getpaseo", "server");
const pluginsDir = path.join(serverRoot, "dist", "server", "server", "plugins");
const hostModule = (file) => import(pathToFileURL(path.join(pluginsDir, file)).href);

const { compilePlugin } = await hostModule("compiler.js");
const { readPluginManifest } = await hostModule("manifest.js");
const { evaluateBundle } = await hostModule("bundle-evaluator.js");
const { assertPluginCompatibility } = await import("@getpaseo/protocol/plugin-requirements");

const hostVersion = JSON.parse(
  await readFile(path.join(serverRoot, "package.json"), "utf8"),
).version;
const manifest = await readPluginManifest(root);
assertPluginCompatibility({ ...manifest, version: hostVersion, runtime: "daemon" });

const { clientBundle, serverBundle } = await compilePlugin({
  client: path.join(root, "index.client.tsx"),
  server: path.join(root, "index.server.ts"),
});
if (!clientBundle || !serverBundle) throw new Error("Expected both a client and a server bundle");

const server = recordServerContributions(evaluateBundle(serverBundle));
const client = recordClientContributions(clientBundle);

console.log(
  JSON.stringify(
    {
      host: hostVersion,
      manifest: { id: manifest.id, requirements: manifest.requirements },
      bundles: { client: clientBundle.length, server: serverBundle.length },
      server,
      client,
    },
    null,
    2,
  ),
);

function recordServerContributions(setup) {
  const recorded = { settings: [], rpc: [], events: [], before: [] };
  const cleanup = setup({
    registerSettings(definition) {
      recorded.settings.push(definition.id);
      return {
        read: async () => ({ status: "ready", revision: "missing", values: {} }),
        subscribe: () => () => {},
      };
    },
    handle(contract, handler) {
      if (typeof handler !== "function") throw new Error(`RPC ${contract.name} has no handler`);
      recorded.rpc.push(contract.name);
    },
    on(name) {
      recorded.events.push(name);
      return () => {};
    },
    before(name) {
      recorded.before.push(name);
      return () => {};
    },
    registerProvider() {
      throw new Error("Unexpected provider registration");
    },
    registerUsageSource() {
      throw new Error("Unexpected usage source registration");
    },
  });
  if (typeof cleanup !== "function") throw new Error("Server contribution must return a cleanup");
  return recorded;
}

// The client bundle runs in React Native. Host modules are external, so any stub that survives
// module evaluation is enough to exercise registration.
function recordClientContributions(bundle) {
  const stub = new Proxy(function stub() {}, {
    get: (_target, key) => {
      if (key === "create") return (styles) => styles;
      if (key === "hairlineWidth") return 1;
      if (key === "OS") return "web";
      if (key === "__esModule") return false;
      if (key === Symbol.toPrimitive) return () => "stub";
      return stub;
    },
    apply: () => stub,
  });
  const factory = vm.runInThisContext(bundle);
  const exports = factory((name) => {
    if (name === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null, Fragment: "f" };
    if (name === "react") {
      return { createContext: () => stub, useState: stub, useEffect: stub, useMemo: stub };
    }
    return stub;
  });
  const contribute = exports?.default;
  if (typeof contribute !== "function") throw new Error("Client bundle must default export");
  const recorded = {};
  const add = (kind) => (contribution) => {
    recorded[kind] ??= [];
    recorded[kind].push(contribution.id ?? contribution.name ?? "?");
    return () => {};
  };
  const cleanup = contribute(
    new Proxy(
      {},
      {
        get: (_target, key) => {
          if (typeof key !== "string") return undefined;
          if (key === "i18n") return { locale: "zh-Hans", t: (_messages, value) => value };
          if (key.startsWith("add")) return add(key);
          return () => {};
        },
      },
    ),
  );
  if (typeof cleanup !== "function") throw new Error("Client contribution must return a cleanup");
  return recorded;
}
