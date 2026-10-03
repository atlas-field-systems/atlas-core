import { lookupCommand, type components } from "@atlas-field-systems/sdk";
import type { components as ProtocolComponents } from "@atlas-field-systems/sdk/protocol";

const pause: components["schemas"]["Pause"] = { command: "pause" };
const publicPause: ProtocolComponents["schemas"]["Pause"] = pause;
lookupCommand(publicPause.command)?.validateInput(publicPause);

// @ts-expect-error The public declaration preserves Pause's literal Command.
const wrongPause: ProtocolComponents["schemas"]["Pause"] = { command: "move_to" };
void wrongPause;
