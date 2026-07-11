import { dump as dumpYaml } from "js-yaml";

export interface KubeconfigInput {
  server: string;
  caPem: string;
  clientCertPem: string;
  clientKeyPem: string;
  userName?: string;
  clusterName?: string;
}

/** Render a self-contained kubeconfig (all credentials inlined as base64). */
export function buildKubeconfig(input: KubeconfigInput): string {
  const cluster = input.clusterName ?? "envtest";
  const user = input.userName ?? "envtest-admin";
  const b64 = (pem: string) => Buffer.from(pem).toString("base64");
  const config = {
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      {
        name: cluster,
        cluster: {
          server: input.server,
          "certificate-authority-data": b64(input.caPem),
        },
      },
    ],
    users: [
      {
        name: user,
        user: {
          "client-certificate-data": b64(input.clientCertPem),
          "client-key-data": b64(input.clientKeyPem),
        },
      },
    ],
    contexts: [
      {
        name: cluster,
        context: { cluster, user },
      },
    ],
    "current-context": cluster,
  };
  return dumpYaml(config);
}
