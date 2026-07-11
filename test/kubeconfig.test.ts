import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";


import { buildKubeconfig, loadKubeconfig, parseKubeconfig } from "../src/client/kubeconfig.js";
import { mergeArgs, renderArgs } from "../src/controlplane/args.js";
import { withEnv } from "./helpers/env.js";

describe("buildKubeconfig", () => {
  it("renders a self-contained kubeconfig with inlined credentials", () => {
    const text = buildKubeconfig({
      server: "https://127.0.0.1:12345",
      caPem: "CA",
      clientCertPem: "CERT",
      clientKeyPem: "KEY",
    });
    const config = parseYaml(text) as any;
    expect(config.kind).toBe("Config");
    expect(config.clusters[0].cluster.server).toBe("https://127.0.0.1:12345");
    expect(
      Buffer.from(config.clusters[0].cluster["certificate-authority-data"], "base64").toString(),
    ).toBe("CA");
    expect(
      Buffer.from(config.users[0].user["client-certificate-data"], "base64").toString(),
    ).toBe("CERT");
    expect(Buffer.from(config.users[0].user["client-key-data"], "base64").toString()).toBe("KEY");
    expect(config["current-context"]).toBe("envtest");
    expect(config.contexts[0].context.user).toBe("envtest-admin");
  });
});

describe("parseKubeconfig", () => {
  it("round-trips what buildKubeconfig renders (inline data fields)", async () => {
    const yaml = buildKubeconfig({
      server: "https://127.0.0.1:12345",
      caPem: "CA",
      clientCertPem: "CERT",
      clientKeyPem: "KEY",
      userName: "jane",
      clusterName: "unit",
    });
    const parsed = await parseKubeconfig(yaml);
    expect(parsed.config).toEqual({
      server: "https://127.0.0.1:12345",
      caPem: "CA",
      certPem: "CERT",
      keyPem: "KEY",
    });
    expect(parsed.context).toBe("unit");
    expect(parsed.cluster).toBe("unit");
    expect(parsed.user).toBe("jane");
  });

  it("resolves certificate file references relative to baseDir, like kubectl", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "envtest-kc-"));
    try {
      await fsp.writeFile(path.join(dir, "ca.crt"), "FILE-CA");
      await fsp.writeFile(path.join(dir, "client.crt"), "FILE-CERT");
      await fsp.writeFile(path.join(dir, "client.key"), "FILE-KEY");
      const yaml = dumpYaml({
        "current-context": "c",
        clusters: [
          { name: "c", cluster: { server: "https://example:6443", "certificate-authority": "ca.crt" } },
        ],
        users: [
          { name: "u", user: { "client-certificate": "client.crt", "client-key": "client.key" } },
        ],
        contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
      });
      const parsed = await parseKubeconfig(yaml, { baseDir: dir });
      expect(parsed.config).toEqual({
        server: "https://example:6443",
        caPem: "FILE-CA",
        certPem: "FILE-CERT",
        keyPem: "FILE-KEY",
      });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("selects an explicit context over current-context", async () => {
    const yaml = dumpYaml({
      "current-context": "first",
      clusters: [
        { name: "one", cluster: { server: "https://one", "certificate-authority-data": b64("CA1") } },
        { name: "two", cluster: { server: "https://two", "certificate-authority-data": b64("CA2") } },
      ],
      users: [
        { name: "u", user: { "client-certificate-data": b64("C"), "client-key-data": b64("K") } },
      ],
      contexts: [
        { name: "first", context: { cluster: "one", user: "u" } },
        { name: "second", context: { cluster: "two", user: "u" } },
      ],
    });
    expect((await parseKubeconfig(yaml)).config.server).toBe("https://one");
    const second = await parseKubeconfig(yaml, { context: "second" });
    expect(second.config.server).toBe("https://two");
    expect(second.config.caPem).toBe("CA2");
  });

  // kubectl/client-go accept a scheme-less server and default to https;
  // without normalization new URL("myhost:6443") would treat "myhost:" as
  // the protocol and silently misreport the port as 443.
  it("normalizes a scheme-less server to https, like kubectl", async () => {
    const yaml = dumpYaml({
      "current-context": "c",
      clusters: [
        { name: "c", cluster: { server: "myhost:6443", "certificate-authority-data": b64("CA") } },
      ],
      users: [
        { name: "u", user: { "client-certificate-data": b64("C"), "client-key-data": b64("K") } },
      ],
      contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
    });
    expect((await parseKubeconfig(yaml)).config.server).toBe("https://myhost:6443");

    // Plain http can never work against this mTLS-only client stack.
    const http = yaml.replace("myhost:6443", "http://myhost:6443");
    await expect(parseKubeconfig(http)).rejects.toThrow("must be an https URL");
  });

  it("rejects unusable kubeconfigs with pointed errors", async () => {
    await expect(parseKubeconfig("")).rejects.toThrow("empty");

    const base = {
      clusters: [
        { name: "c", cluster: { server: "https://c", "certificate-authority-data": b64("CA") } },
      ],
      users: [
        { name: "u", user: { "client-certificate-data": b64("C"), "client-key-data": b64("K") } },
      ],
      contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
    };
    // No current-context and none passed.
    await expect(parseKubeconfig(dumpYaml(base))).rejects.toThrow("current-context");
    // A context that isn't there.
    await expect(parseKubeconfig(dumpYaml(base), { context: "nope" })).rejects.toThrow('"nope"');
    // Token-only user: not client-certificate auth.
    const tokenUser = {
      ...base,
      "current-context": "c",
      users: [{ name: "u", user: { token: "sekrit" } }],
    };
    await expect(parseKubeconfig(dumpYaml(tokenUser))).rejects.toThrow("client-certificate auth");
    // Corrupted inline data: Node's lenient base64 decoder would silently
    // produce garbage PEM that fails later as an opaque TLS error.
    const badData = {
      ...base,
      "current-context": "c",
      clusters: [
        { name: "c", cluster: { server: "https://c", "certificate-authority-data": "n0t base64!!" } },
      ],
    };
    await expect(parseKubeconfig(dumpYaml(badData))).rejects.toThrow(
      'invalid base64 in "certificate-authority-data"',
    );
    // No cluster CA: we never skip TLS verification.
    const noCA = {
      ...base,
      "current-context": "c",
      clusters: [{ name: "c", cluster: { server: "https://c", "insecure-skip-tls-verify": true } }],
    };
    await expect(parseKubeconfig(dumpYaml(noCA))).rejects.toThrow("insecure-skip-tls-verify");
  });
});

describe("loadKubeconfig", () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "envtest-kc-load-"));
    // File-referenced CA proves relative paths resolve against the
    // kubeconfig's own directory, not the process cwd.
    await fsp.writeFile(path.join(dir, "ca.crt"), "FILE-CA");
    file = path.join(dir, "kubeconfig");
    await fsp.writeFile(
      file,
      dumpYaml({
        "current-context": "c",
        clusters: [
          { name: "c", cluster: { server: "https://loaded:6443", "certificate-authority": "ca.crt" } },
        ],
        users: [
          { name: "u", user: { "client-certificate-data": b64("C"), "client-key-data": b64("K") } },
        ],
        contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
      }),
    );
  });

  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("loads an explicit path", async () => {
    const loaded = await loadKubeconfig({ path: file });
    expect(loaded.path).toBe(file);
    expect(loaded.config.server).toBe("https://loaded:6443");
    expect(loaded.config.caPem).toBe("FILE-CA");
  });

  // Upstream config_test: "should prefer the flag over the envvar" — our
  // `path` option is the --kubeconfig analog.
  it("prefers an explicit path over KUBECONFIG", async () => {
    const other = path.join(dir, "other-kubeconfig");
    await fsp.writeFile(
      other,
      buildKubeconfig({
        server: "https://other:6443",
        caPem: "CA",
        clientCertPem: "C",
        clientKeyPem: "K",
      }),
    );
    const loaded = await withEnv({ KUBECONFIG: other }, () => loadKubeconfig({ path: file }));
    expect(loaded.config.server).toBe("https://loaded:6443");
  });

  // Upstream config_test: "should use the envvar". For multi-value lists
  // upstream merges the files ("should support a multi-value envvar"); we
  // deliberately diverge and take the first READABLE entry only — missing
  // files are skipped like kubectl skips them (CI tooling commonly prepends
  // a possibly-absent path).
  it("falls back to the first readable KUBECONFIG entry", async () => {
    const firstWins = await withEnv(
      { KUBECONFIG: [file, path.join(dir, "ignored")].join(path.delimiter) },
      () => loadKubeconfig(),
    );
    expect(firstWins.path).toBe(file);
    expect(firstWins.config.server).toBe("https://loaded:6443");

    const missingFirst = await withEnv(
      { KUBECONFIG: [path.join(dir, "does-not-exist"), file].join(path.delimiter) },
      () => loadKubeconfig(),
    );
    expect(missingFirst.path).toBe(file);
  });

  it("reports every tried entry when no KUBECONFIG file is readable", async () => {
    const missingA = path.join(dir, "missing-a");
    const missingB = path.join(dir, "missing-b");
    await expect(
      withEnv({ KUBECONFIG: [missingA, missingB].join(path.delimiter) }, () => loadKubeconfig()),
    ).rejects.toThrow(/missing-a.*missing-b/s);
  });

  // Upstream config_test: "should allow overriding the context".
  it("passes an explicit context through", async () => {
    const multi = path.join(dir, "multi-kubeconfig");
    await fsp.writeFile(
      multi,
      dumpYaml({
        "current-context": "c1",
        clusters: [
          { name: "one", cluster: { server: "https://one", "certificate-authority-data": b64("CA") } },
          { name: "two", cluster: { server: "https://two", "certificate-authority-data": b64("CA") } },
        ],
        users: [
          { name: "u", user: { "client-certificate-data": b64("C"), "client-key-data": b64("K") } },
        ],
        contexts: [
          { name: "c1", context: { cluster: "one", user: "u" } },
          { name: "c2", context: { cluster: "two", user: "u" } },
        ],
      }),
    );
    const loaded = await loadKubeconfig({ path: multi, context: "c2" });
    expect(loaded.context).toBe("c2");
    expect(loaded.config.server).toBe("https://two");
  });

  // Upstream config_test: "when kubeconfig files don't exist ... should fail".
  it("names the file it could not read", async () => {
    const missing = path.join(dir, "does-not-exist");
    await expect(loadKubeconfig({ path: missing })).rejects.toThrow("does-not-exist");
  });
});

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("flag merging", () => {
  it("overrides defaults, removes on null, and tolerates -- prefixes", () => {
    const merged = mergeArgs(
      { "secure-port": "1", "allow-privileged": "true" },
      { "--secure-port": "2", "allow-privileged": null, "v": "4" },
    );
    expect(merged).toEqual({ "secure-port": "2", v: "4" });
    expect(renderArgs(merged).sort()).toEqual(["--secure-port=2", "--v=4"]);
  });

  // Upstream models args as map[string][]string: a flag may repeat.
  it("renders array values as repeated flags", () => {
    const merged = mergeArgs(
      { "enable-admission-plugins": "NamespaceLifecycle" },
      { "audit-policy-file": ["a.yaml", "b.yaml"] },
    );
    expect(renderArgs(merged).sort()).toEqual([
      "--audit-policy-file=a.yaml",
      "--audit-policy-file=b.yaml",
      "--enable-admission-plugins=NamespaceLifecycle",
    ]);
  });
});
