import { readFile } from "node:fs/promises";
import path from "node:path";

import { repository } from "./core.mjs";

/** Reads an independently authored wire example from protocol/fixtures. */
export async function fixture(name) {
  return JSON.parse(await readFile(path.join(repository, "protocol", "fixtures", `${name}.json`), "utf8"));
}
