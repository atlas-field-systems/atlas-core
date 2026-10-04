import { lookupCommand, responseValidation, type components } from "@atlas-field-systems/sdk";
import type { components as ProtocolComponents } from "@atlas-field-systems/sdk/protocol";

const pause: components["schemas"]["Pause"] = { command: "pause" };
const publicPause: ProtocolComponents["schemas"]["Pause"] = pause;
lookupCommand(publicPause.command)?.validateInput(publicPause);

// @ts-expect-error The public declaration preserves Pause's literal Command.
const wrongPause: ProtocolComponents["schemas"]["Pause"] = { command: "move_to" };
void wrongPause;

const pathMetadata = {
  components: { schemas: {} },
  paths: { "/example": {
    summary: "Shared metadata", description: "Supported Path Item shape",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    servers: [{ url: "http://example.invalid" }],
    get: { responses: { "204": {} } },
  } },
};
responseValidation(pathMetadata, { datasetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", protocolVersion: "0.2.0" }, { maxJSONBytes: 1_048_576 });
// @ts-expect-error Metadata support does not remove the operation responses requirement.
responseValidation({ components: { schemas: {} }, paths: { "/example": { get: { summary: "missing responses" } } } }, { datasetId: "id", protocolVersion: "0.2.0" }, { maxJSONBytes: 1_048_576 });

// @ts-expect-error Response validation requires an explicit caller-selected JSON byte bound.
responseValidation(pathMetadata, { datasetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", protocolVersion: "0.2.0" });
