import { readFile, writeFile } from "node:fs/promises";

const source = new URL("../../protocol/command-catalog.json", import.meta.url);
const target = new URL("../src/generated/catalog.ts", import.meta.url);
const catalog = JSON.parse(await readFile(source, "utf8"));
await writeFile(target, `// Generated from protocol/command-catalog.json. Do not edit.\nexport const commandCatalog = ${JSON.stringify(catalog, null, 2)} as const;\n`);
