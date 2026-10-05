#!/usr/bin/env node
// Check the lint command with independent allowed/prohibited programs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "Atlas SDK/checks/.lint-probes-"));
const lint = join(root, "scripts/lint-typescript.mjs");
const tsc = join(root, "Atlas SDK/node_modules/typescript/lib/tsc.js");
const probes = [
  { name: "explicit-any.ts", source: "const value: any = 1;", rule: "explicit any" },
  { name: "ignore.ts", source: "// @ts-ignore\nconst value: string = 1;", rule: "type-error suppression" },
  { name: "nocheck.ts", source: "/* @ts-nocheck */\nconst value: string = 1;", rule: "type-error suppression" },
  {
    name: "implementation-expect.ts",
    source: "// @ts-expect-error\nconst value: string = 1;",
    rule: "type-error suppression",
  },
  {
    name: "double-assertion.ts",
    source: "const input: unknown = 1; const value = (input as unknown) as string;",
    rule: "double assertions",
  },
  {
    name: "cast-function.ts",
    source: "function value(input: unknown) { return input as string; }",
    rule: "cast-only functions",
  },
  {
    name: "cast-arrow.ts",
    source: "const value = (input: unknown) => (input as string);",
    rule: "cast-only functions",
  },
  {
    name: "allowed.ts",
    source:
      "const value = { kind: 'position' } as const satisfies { kind: string };\nconst label = `example ${value.kind} // @ts-ignore`;\nconst pattern = /\\/\\/ @ts-ignore/;\nfunction checked(input: unknown): string { if (typeof input !== 'string') throw new Error('invalid'); return input; }",
  },
  {
    name: "negative.type-test.ts",
    source: "// @ts-expect-error A number cannot satisfy the required string.\nconst value: string = 1;",
  },
];

function execute(tool, arguments_) {
  const result = spawnSync(process.execPath, [tool, ...arguments_], { encoding: "utf8", timeout: 20_000 });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${tool} terminated unexpectedly`);
  return result;
}

try {
  for (const probe of probes) {
    const path = join(directory, probe.name);
    writeFileSync(path, probe.source + "\n");
    const result = execute(lint, [path]);
    assert.equal(result.status, probe.rule ? 1 : 0, `${probe.name}: ${result.stdout}${result.stderr}`);
    if (probe.rule) assert(result.stderr.includes(probe.rule), probe.name);
  }
  const negative = join(directory, "negative.type-test.ts");
  const compilerOptions = [
    "--noEmit",
    "--strict",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2023",
    negative,
  ];
  assert.equal(execute(tsc, compilerOptions).status, 0, "a genuine negative type test compiles");
  writeFileSync(negative, "// @ts-expect-error The intended mismatch disappeared.\nconst value: string = 'valid';\n");
  const disappeared = execute(tsc, compilerOptions);
  assert.equal(disappeared.status, 2, "the compiler refuses a negative type test whose error disappeared");
  assert(disappeared.stdout.includes("Unused '@ts-expect-error' directive"));
  console.log("PASS TypeScript lint refusals, const/satisfies allowance and compiler-checked negative type tests");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
