import { readS1Config, runSDKWorkflow } from "./workflow.js";

const configPath = process.argv[process.argv.indexOf("--config") + 1];
if (!process.argv.includes("--config") || !configPath) throw new Error("S1 demo requires --config PATH");
const result = await runSDKWorkflow(await readS1Config(configPath));
console.log(JSON.stringify(result));
