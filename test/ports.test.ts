import { describe, expect, it } from "vitest";

import { connectHostFor, getFreePort, hostPort } from "../src/controlplane/ports.js";

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
