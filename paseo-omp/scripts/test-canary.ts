import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { pluginRoot } from "./host-tools-integration";

const executeFile = promisify(execFile);
const composeFile = "canary/compose.yml";
const defaultVersion = "18.1.15";
const releaseChecksums: Record<string, { amd64: string; arm64: string }> = {
  "17.2.15": {
    amd64: "fa884941f932f4f5d2046acba971790ae6aae18fd4806472b01f041de670368a",
    arm64: "36507ba3d98332f52649d22009ead86f154ab007cb169d68690fa2b0111769ad",
  },
  "17.3.4": {
    amd64: "3fce4b25628064b0cd7bfbc6245ecdada331750ed4b341aca6bd29ba4478aab5",
    arm64: "8e27e7bfe49fc0f33f6cb0b50128ab85fe5403330d1dfb5bb34cf1f7422cdce8",
  },
  "18.0.11": {
    amd64: "6054460b29e9bad5eba78336f291e1979c2fa0a5cd96fc2d92afd666cc681d26",
    arm64: "e5f77cb65aa2dc777a8a5932be3b2e6a44271c8df2eb209cea6f04f212f3f010",
  },
  "18.1.10": {
    amd64: "e91d5598ee47e1d4099fd8686dc9f61c9b755f2ea077d5f1774aba1072321f9e",
    arm64: "aba7beb612459789e539db980c95680c26d26ca0d67776152fce70cc6e1dac06",
  },
  "18.1.15": {
    amd64: "747518a41fbb32ac47491b4677a7a921d0d9e5977ae006c358d6836813149adc",
    arm64: "2e1142ccd4bb76413b63a05711ac51c7b95551f36387ef295661bb86f0576189",
  },
  "18.1.22": {
    amd64: "9ccddf1091e01e08fea1f8e1208f8901cc90d5d098b16581672eeab03f118b81",
    arm64: "62433d49063eed2e90d3cb14729b3a608d6665348f9fdddb8757680b026059ec",
  },
  "18.2.0": {
    amd64: "41b67a43f18a7cd33cc0dd772a4fa042cd20ab6c57e6bd451ff6dbe55a7978d8",
    arm64: "afd6884b192290d02ff79008e891cabee326dea23e853af549aff8ce88064566",
  },
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a canary port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function run(command: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const [file, ...args] = command;
  if (!file) throw new Error("Canary command must not be empty");
  const { stdout, stderr } = await executeFile(file, args, {
    cwd: pluginRoot,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return `${stdout}${stderr}`.trim();
}

const version = process.env.PASEO_CANARY_OMP_VERSION ?? defaultVersion;
const knownChecksums = releaseChecksums[version];
const amd64 = process.env.PASEO_CANARY_OMP_SHA256_AMD64 ?? knownChecksums?.amd64;
const arm64 = process.env.PASEO_CANARY_OMP_SHA256_ARM64 ?? knownChecksums?.arm64;
if (!amd64 || !arm64) {
  throw new Error(
    `OMP ${version} is not pinned; set PASEO_CANARY_OMP_SHA256_AMD64 and PASEO_CANARY_OMP_SHA256_ARM64`,
  );
}

const project = `paseo-omp-canary-${process.pid}-${randomUUID().slice(0, 8)}`;
const password = randomUUID();
const [paseoPort, mockPort] = await Promise.all([freePort(), freePort()]);
const env = {
  ...process.env,
  PASEO_CANARY_IMAGE: `${project}:local`,
  PASEO_CANARY_MOCK_PORT: String(mockPort),
  PASEO_CANARY_OMP_SHA256_AMD64: amd64,
  PASEO_CANARY_OMP_SHA256_ARM64: arm64,
  PASEO_CANARY_OMP_VERSION: version,
  PASEO_CANARY_PASSWORD: password,
  PASEO_CANARY_PORT: String(paseoPort),
};
const compose = ["docker", "compose", "-p", project, "-f", composeFile];
let failure: unknown;
try {
  await run([...compose, "up", "--build", "--detach", "--wait", "--wait-timeout", "240"], env);
  const output = await run([process.execPath, "--import", "tsx", "canary/smoke.ts"], {
    ...env,
    PASEO_CANARY_URL: `ws://127.0.0.1:${paseoPort}/ws`,
  });
  console.log(output);
} catch (error) {
  failure = error;
  const logs = await run([...compose, "logs", "--no-color"], env).catch(
    (logError) => `Could not collect canary logs: ${String(logError)}`,
  );
  console.error(logs);
} finally {
  await run([...compose, "down", "--volumes", "--remove-orphans"], env).catch((error) => {
    console.error(`Could not clean up canary services: ${String(error)}`);
  });
  await run(["docker", "image", "rm", env.PASEO_CANARY_IMAGE], env).catch((error) => {
    console.error(`Could not remove canary image: ${String(error)}`);
  });
}
if (failure) throw failure;
