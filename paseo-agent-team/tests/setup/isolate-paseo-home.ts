import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const previousPaseoHome = process.env.PASEO_HOME;
const isolatedPaseoHome = mkdtempSync(path.join(tmpdir(), "paseo-vitest-home-"));
process.env.PASEO_HOME = isolatedPaseoHome;
process.env.PASEO_VITEST_HOME_MARK = isolatedPaseoHome;

afterAll(() => {
  if (previousPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousPaseoHome;
  delete process.env.PASEO_VITEST_HOME_MARK;
  rmSync(isolatedPaseoHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
