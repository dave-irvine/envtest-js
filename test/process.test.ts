// Intentions from upstream process_test.go (Start/Stop method behaviors),
// using process.execPath -e children so the suite runs under Node and Bun.
import { describe, expect, it } from "vitest";

import { ManagedProcess } from "../src/controlplane/process.js";

const NODE = process.execPath;
const HANG = "setTimeout(() => {}, 30000)"; // stay alive until killed

function managed(args: {
  command?: string;
  script?: string;
  ready?: boolean;
  readyCheck?: () => Promise<boolean>;
  readyPollIntervalMs?: number;
  startTimeoutMs?: number;
}): ManagedProcess {
  return new ManagedProcess({
    name: "fake-control-plane",
    command: args.command ?? NODE,
    args: args.script === undefined ? [] : ["-e", args.script],
    readyCheck: args.readyCheck ?? (async () => args.ready ?? false),
    readyPollIntervalMs: args.readyPollIntervalMs,
    startTimeoutMs: args.startTimeoutMs ?? 1_000,
    stopTimeoutMs: 2_000,
  });
}

describe("ManagedProcess.start", () => {
  it("starts once the ready check passes", async () => {
    const proc = managed({ script: HANG, ready: true });
    await proc.start();
    expect(proc.pid).toBeGreaterThan(0);
    await proc.stop();
  });

  it("returns a timeout error when the process never becomes ready", async () => {
    const proc = managed({ script: HANG, ready: false, startTimeoutMs: 500 });
    const err = await proc.start().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/did not become ready within 500ms/);
  });

  it("reports an early exit with the captured output", async () => {
    const proc = managed({
      script: "console.log('boom: bad flag combination'); process.exit(3)",
      ready: false,
    });
    const err = await proc.start().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/exited before becoming ready/);
    expect((err as Error).message).toContain("boom: bad flag combination");
  });

  it("propagates spawn failures, and Stop() afterwards does not throw", async () => {
    const proc = managed({ command: "definitely-not-a-real-binary-xyz", script: "" });
    const err = await proc.start().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    // Slow CI runners can deliver the ENOENT after the ready-poll deadline,
    // in which case the timeout error reports instead of the early-exit one
    // — either proves the spawn failure surfaced as a start() error.
    expect((err as Error).message).toMatch(/exited before becoming ready|did not become ready/);
    await proc.stop(); // upstream: "but Stop() is called on it — does not panic"
  });

  it("captures stdout and stderr for inspection", async () => {
    const proc = managed({
      script: "console.log('to stdout'); console.error('to stderr'); " + HANG,
      ready: true,
    });
    await proc.start();
    // Output is captured asynchronously; poll briefly.
    const deadline = Date.now() + 2_000;
    while (
      (!proc.capturedOutput.includes("to stdout") ||
        !proc.capturedOutput.includes("to stderr")) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(proc.capturedOutput).toContain("to stdout");
    expect(proc.capturedOutput).toContain("to stderr");
    await proc.stop();
  });
});

// Upstream process_test.go exercises both the default poll interval and a
// configured one ("if a health check poll interval is specified, uses it").
describe("ManagedProcess readiness polling", () => {
  it("polls at the configured interval", async () => {
    let checks = 0;
    const proc = managed({
      script: HANG,
      readyCheck: async () => ++checks >= 3,
      readyPollIntervalMs: 200,
      startTimeoutMs: 5_000,
    });
    const started = Date.now();
    await proc.start();
    expect(checks).toBe(3);
    // Two sleeps separate the three checks; allow a little timer jitter.
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    await proc.stop();
  });

  it("polls at the default 150ms interval when unset", async () => {
    let checks = 0;
    const proc = managed({
      script: HANG,
      readyCheck: async () => {
        checks++;
        return false;
      },
      startTimeoutMs: 500,
    });
    await proc.start().catch(() => {});
    // ~1 + 500/150 checks; the bounds prove it neither busy-loops nor stalls.
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(checks).toBeLessThanOrEqual(6);
  });

  it("rejects a non-positive poll interval", () => {
    expect(() => managed({ script: HANG, readyPollIntervalMs: 0 })).toThrow(
      /readyPollIntervalMs must be a positive number/,
    );
    expect(() => managed({ script: HANG, readyPollIntervalMs: -1 })).toThrow(
      /readyPollIntervalMs must be a positive number/,
    );
  });
});

describe("ManagedProcess.stop", () => {
  it("stops the process, and consecutive calls do not throw", async () => {
    const proc = managed({ script: HANG, ready: true });
    await proc.start();
    await proc.stop();
    await proc.stop(); // upstream: "multiple times — does not error or panic"
  });

  it("is a no-op before start", async () => {
    const proc = managed({ script: HANG });
    await proc.stop();
  });
});
