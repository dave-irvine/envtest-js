// Minimal ambient declaration of the bun:test surface the preload script
// (test/bun-preload.ts) uses, so plain tsc (types: ["node"]) can typecheck
// without adopting bun-types' globals project-wide. Test files don't need
// this: they import from "vitest", which `bun test` remaps to bun:test at
// runtime. Not shipped (package files: dist only).
declare module "bun:test" {
  type TestFn = () => void | Promise<unknown>;
  export function beforeAll(fn: TestFn): void;
  export function afterAll(fn: TestFn): void;
}
