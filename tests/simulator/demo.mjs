// Launches the TypeScript S1 demonstration with the SDK's locked tsx loader.
import { register } from "../../Atlas SDK/node_modules/tsx/dist/esm/api/index.mjs";

register();
await import("./demo.ts");
