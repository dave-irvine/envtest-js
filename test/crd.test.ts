import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "./helpers/runner.js";

import { installCRDs, uninstallCRDs, type RestConfig } from "../src/index.js";

const MISSING = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "does-not-exist",
);

// Never contacted: with every path missing (and skipping enabled) there are
// no manifests, so no REST call is ever made.
const config: RestConfig = {
  server: "https://127.0.0.1:1",
  caPem: "",
  certPem: "",
  keyPem: "",
};

async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return String(err);
  }
  return "(resolved without error)";
}

describe("errorIfPathMissing", () => {
  // Deliberate deviation from upstream, which skips silently by default —
  // see InstallCRDsOptions.errorIfPathMissing.
  it("installCRDs throws on a missing path by default", async () => {
    expect(await rejectionOf(installCRDs(config, [MISSING]))).toMatch(
      /CRD path does not exist: .*does-not-exist/,
    );
  });

  it("installCRDs skips missing paths when disabled", async () => {
    expect(await installCRDs(config, [MISSING], { errorIfPathMissing: false })).toEqual([]);
  });

  it("uninstallCRDs throws on a missing path by default", async () => {
    expect(await rejectionOf(uninstallCRDs(config, [MISSING]))).toMatch(
      /CRD path does not exist: .*does-not-exist/,
    );
  });

  it("uninstallCRDs skips missing paths when disabled", async () => {
    expect(await uninstallCRDs(config, [MISSING], { errorIfPathMissing: false })).toEqual([]);
  });
});

describe("pollIntervalMs validation", () => {
  // Rejected up front, before any manifests are read or REST calls made — a
  // zero/negative interval would otherwise poll as fast as the event loop
  // allows.
  for (const bad of [0, -100, NaN, Infinity]) {
    it(`installCRDs rejects pollIntervalMs = ${bad}`, async () => {
      expect(await rejectionOf(installCRDs(config, [], { pollIntervalMs: bad }))).toMatch(
        /pollIntervalMs must be a positive number/,
      );
    });
  }
});
