import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";


import { buildKubeconfig } from "../src/client/kubeconfig.js";
import { mergeArgs, renderArgs } from "../src/controlplane/args.js";

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
