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
  paths: {
    "/example": {
      summary: "Shared metadata",
      description: "Supported Path Item shape",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      servers: [{ url: "http://example.invalid" }],
      get: { responses: { "204": {} } },
    },
  },
};
const context = { datasetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", protocolVersion: "0.2.0" };
const bound = { maxJSONBytes: 1_048_576 };
responseValidation(pathMetadata, context, bound);

// Each expected error must stay on the line after its directive, so keep these
// calls short enough that formatting never wraps them.
const missingResponses = { "/example": { get: { summary: "missing responses" } } };
// @ts-expect-error Metadata support does not remove the operation responses requirement.
responseValidation({ components: { schemas: {} }, paths: missingResponses }, context, bound);

// @ts-expect-error Response validation requires an explicit caller-selected JSON byte bound.
responseValidation(pathMetadata, context);
