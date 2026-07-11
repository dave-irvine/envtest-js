import { describe, expect, it } from "vitest";

import { archiveFor, parseReleaseIndex, selectVersion } from "../src/setup/releases.js";

const SAMPLE = `
releases:
  v1.35.0:
    envtest-v1.35.0-linux-amd64.tar.gz:
      hash: aaa
      selfLink: https://example.com/envtest-v1.35.0-linux-amd64.tar.gz
    envtest-v1.35.0-windows-amd64.tar.gz:
      hash: bbb
      selfLink: https://example.com/envtest-v1.35.0-windows-amd64.tar.gz
  v1.36.0:
    envtest-v1.36.0-windows-amd64.tar.gz:
      hash: ccc
      selfLink: https://example.com/envtest-v1.36.0-windows-amd64.tar.gz
  v1.36.2:
    envtest-v1.36.2-windows-amd64.tar.gz:
      hash: ddd
      selfLink: https://example.com/envtest-v1.36.2-windows-amd64.tar.gz
  v1.37.0-alpha.1:
    envtest-v1.37.0-alpha.1-windows-amd64.tar.gz:
      hash: eee
      selfLink: https://example.com/envtest-v1.37.0-alpha.1-windows-amd64.tar.gz
`;

describe("release index", () => {
  const index = parseReleaseIndex(SAMPLE);

  it("rejects malformed indexes", () => {
    expect(() => parseReleaseIndex("nope: true")).toThrow(/releases/);
  });

  it("selects the latest stable version by default (prereleases excluded)", () => {
    expect(selectVersion(index)).toBe("v1.36.2");
  });

  it("selects exact versions, with or without the v prefix", () => {
    expect(selectVersion(index, "v1.36.0")).toBe("v1.36.0");
    expect(selectVersion(index, "1.35.0")).toBe("v1.35.0");
  });

  it("selects the newest patch of a minor series", () => {
    expect(selectVersion(index, "1.36")).toBe("v1.36.2");
  });

  // Upstream setup-envtest selectors_test: "any patch" selectors ("X.Y.*").
  it("supports setup-envtest style wildcard patch selectors", () => {
    expect(selectVersion(index, "1.36.*")).toBe("v1.36.2");
    expect(selectVersion(index, "1.35.x")).toBe("v1.35.0");
  });

  it("allows prereleases when requested exactly", () => {
    expect(selectVersion(index, "v1.37.0-alpha.1")).toBe("v1.37.0-alpha.1");
  });

  it("supports full semver range syntax", () => {
    expect(selectVersion(index, ">=1.35.0 <1.36.2")).toBe("v1.36.0");
    expect(selectVersion(index, "^1.35.0")).toBe("v1.36.2");
  });

  it("compares numeric prerelease identifiers numerically, not lexically", () => {
    const idx = parseReleaseIndex(`
releases:
  v1.37.0-alpha.2:
    envtest-v1.37.0-alpha.2-windows-amd64.tar.gz: { hash: a, selfLink: https://example.com/a }
  v1.37.0-alpha.10:
    envtest-v1.37.0-alpha.10-windows-amd64.tar.gz: { hash: b, selfLink: https://example.com/b }
`);
    // A range with a prerelease bound admits prereleases of that triple;
    // alpha.10 must outrank alpha.2 (lexical comparison would invert this).
    expect(selectVersion(idx, ">=1.37.0-alpha.1")).toBe("v1.37.0-alpha.10");
  });

  it("throws for unknown versions", () => {
    expect(() => selectVersion(index, "v9.9.9")).toThrow(/not found/);
  });

  it("resolves platform archives", () => {
    const archive = archiveFor(index, "v1.36.2", "windows", "amd64");
    expect(archive.hash).toBe("ddd");
    expect(archive.selfLink).toContain("windows-amd64");
    expect(() => archiveFor(index, "v1.36.2", "linux", "arm64")).toThrow(/no envtest archive/);
  });
});
