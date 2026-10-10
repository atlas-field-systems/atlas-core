import assert from "node:assert/strict";
import { readS1Config, runSDKWorkflow, localAction } from "../../examples/s1/workflow.js";
import { runDirectWorkflow } from "./direct.js";
import { runRecoveryWorkflow } from "./recovery.js";

const configPath = process.argv[process.argv.indexOf("--config") + 1];
if (!process.argv.includes("--config") || !configPath) throw new Error("S1 workflow requires --config PATH");
const config = await readS1Config(configPath);
const sdk = await runSDKWorkflow(config);
await localAction(config, "reset");
const direct = await runDirectWorkflow(config);
assert.deepEqual(sdk, direct);
console.log(
  "PASS real container SDK/direct Protocol: all 19 routes, independent outcomes, sparse history, cancellation and deletion",
);
await localAction(config, "reset");
await runRecoveryWorkflow(config);
