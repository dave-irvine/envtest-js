import { describe, expect, it } from "vitest";

import {
  connectHostFor,
  getFreePort,
  hostPort,
  isBindFailure,
  retryOnBindFailure,
} from "../src/controlplane/ports.js";
import { ManagedProcess } from "../src/controlplane/process.js";

describe("hostPort", () => {
  it("joins host and port, bracketing IPv6 literals", () => {
    expect(hostPort("127.0.0.1", 8443)).toBe("127.0.0.1:8443");
    expect(hostPort("localhost", 8443)).toBe("localhost:8443");
    expect(hostPort("::1", 8443)).toBe("[::1]:8443");
    expect(hostPort("fe80::1", 8443)).toBe("[fe80::1]:8443");
  });
});

describe("connectHostFor", () => {
  it("maps wildcard binds to loopback and passes real addresses through", () => {
    expect(connectHostFor("0.0.0.0")).toBe("127.0.0.1");
    expect(connectHostFor("::")).toBe("::1");
    expect(connectHostFor("127.0.0.1")).toBe("127.0.0.1");
    expect(connectHostFor("192.168.1.50")).toBe("192.168.1.50");
    expect(connectHostFor("host.docker.internal")).toBe("host.docker.internal");
  });
});

describe("getFreePort", () => {
  it("returns a usable port number", async () => {
    const port = await getFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});

describe("isBindFailure", () => {
  it("matches the POSIX and Windows bind error texts", () => {
    expect(
      isBindFailure(
        new Error("listen tcp 127.0.0.1:2379: bind: address already in use"),
      ),
    ).toBe(true);
    expect(
      isBindFailure(
        new Error(
          "bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.",
        ),
      ),
    ).toBe(true);
  });

  it("rejects other errors and non-errors", () => {
    expect(isBindFailure(new Error("exit code 1, signal undefined"))).toBe(false);
    expect(isBindFailure("address already in use")).toBe(false);
    expect(isBindFailure(undefined)).toBe(false);
  });
});

describe("retryOnBindFailure", () => {
  const bindError = () =>
    new Error(
      "etcd exited before becoming ready (exit code 1). Output:\nlisten tcp 127.0.0.1:2379: bind: address already in use",
    );

  it("returns on first success without retrying", async () => {
    let calls = 0;
    await retryOnBindFailure(async () => {
      calls++;
    });
    expect(calls).toBe(1);
  });

  it("retries bind failures until one attempt succeeds", async () => {
    let calls = 0;
    await retryOnBindFailure(async () => {
      calls++;
      if (calls < 3) throw bindError();
    });
    expect(calls).toBe(3);
  });

  it("gives up after the attempt budget and rethrows the bind failure", async () => {
    let calls = 0;
    const err = await retryOnBindFailure(async () => {
      calls++;
      throw bindError();
    }).catch((e: Error) => e);
    expect(calls).toBe(3);
    expect((err as Error).message).toMatch(/address already in use/);
  });

  it("propagates non-bind failures immediately", async () => {
    let calls = 0;
    const err = await retryOnBindFailure(async () => {
      calls++;
      throw new Error("bad flag combination");
    }).catch((e: Error) => e);
    expect(calls).toBe(1);
    expect((err as Error).message).toBe("bad flag combination");
  });

  it("retries a real ManagedProcess whose child lost the bind race", async () => {
    // Simulates etcd/kube-apiserver losing the port race: the child prints
    // Go's bind error and exits, whose text lands in the start() error via
    // the captured output.
    let attempts = 0;
    await retryOnBindFailure(async () => {
      attempts++;
      const proc = new ManagedProcess({
        name: "fake-control-plane",
        command: process.execPath,
        args: [
          "-e",
          attempts < 2
            ? "console.error('listen tcp 127.0.0.1:2379: bind: address already in use'); process.exit(1)"
            : "setTimeout(() => {}, 30000)",
        ],
        // Not ready while the doomed first child runs, so its exit is what
        // ends the first attempt (as with a real bind failure).
        readyCheck: async () => attempts >= 2,
        startTimeoutMs: 10_000,
        stopTimeoutMs: 2_000,
      });
      await proc.start();
      await proc.stop();
    });
    expect(attempts).toBe(2);
  });
});
