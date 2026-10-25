import bend from "../dist/protocol.mjs";

function list(values) {
  let result = { $: "Nil" };
  for (let index = values.length - 1; index >= 0; index--)
    result = { $: "Con", head: values[index], tail: result };
  return result;
}

function array(values) {
  const result = [];
  for (let item = values; item.$ === "Con"; item = item.tail)
    result.push(item.head);
  return result;
}

export class ProtocolError extends Error {
  constructor(code, issues = []) {
    super(code);
    this.name = "ProtocolError";
    this.code = code;
    this.issues = issues;
  }
}

function json(value, active = new Set()) {
  if (value === null) return { $: "JNull" };
  if (typeof value === "string") return { $: "JStr", value };
  if (typeof value === "boolean")
    return { $: "JBool", value: { $: value ? "True" : "False" } };
  if (typeof value === "number" && Number.isFinite(value))
    return { $: "JNum", raw: String(value) };
  if (typeof value !== "object" || active.has(value))
    throw new ProtocolError("invalid_value");
  if (Object.getOwnPropertySymbols(value).length)
    throw new ProtocolError("invalid_value");
  active.add(value);
  let result;
  if (Array.isArray(value)) {
    if (Object.getOwnPropertyNames(value).length !== value.length + 1)
      throw new ProtocolError("invalid_value");
    const items = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor))
        throw new ProtocolError("invalid_value");
      items.push(json(descriptor.value, active));
    }
    result = { $: "JArr", items: list(items) };
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new ProtocolError("invalid_value");
    const members = Object.getOwnPropertyNames(value).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor))
        throw new ProtocolError("invalid_value");
      return { $: "Member", key, value: json(descriptor.value, active) };
    });
    result = { $: "JObj", members: list(members) };
  }
  active.delete(value);
  return result;
}

function value(item) {
  switch (item.$) {
    case "JMissing":
      return undefined;
    case "JNull":
      return null;
    case "JBool":
      return item.value.$ === "True";
    case "JNum":
      return Number(item.raw);
    case "JStr":
      return item.value;
    case "JArr":
      return array(item.items).map(value);
    case "JObj":
      return Object.fromEntries(
        array(item.members).map((field) => [field.key, value(field.value)]),
      );
    default:
      throw new Error(`Unknown Bend JSON constructor ${item.$}`);
  }
}

function unwrap(result) {
  if (result.$ === "Done") return result.value;
  if (result.$ !== "Fail")
    throw new Error(`Unknown Bend result constructor ${result.$}`);
  throw new ProtocolError(
    bend.failure_code(result.error),
    array(result.error.issues).map(({ path, message }) => ({ path, message })),
  );
}

const context = (input) => json(input ?? {});
const descriptor = (input) => ({
  ...input,
  headers: [...input.headers.entries()].map(([name, content]) => ({
    name,
    value: content,
  })),
  ...(input.body === undefined ? {} : { body: Array.from(input.body) }),
  ...(input.uploadDescriptor === undefined
    ? {}
    : { uploadDescriptor: Array.from(input.uploadDescriptor) }),
});

export const PROTOCOL_VERSION = "0.1.0";
export function contract(schema, boundary = "http_request") {
  return { schema, boundary };
}
export function readJson(definition, bytes, lower) {
  return value(
    unwrap(
      bend.read_json(
        definition.schema.name,
        definition.boundary,
        list(bytes),
        context(lower),
      ),
    ),
  );
}
export function writeJson(definition, input, lower) {
  return Uint8Array.from(
    array(
      unwrap(
        bend.write_json(
          definition.schema.name,
          definition.boundary,
          json(input),
          context(lower),
        ),
      ),
    ),
  );
}
export function checkJsonBytes(bytes, boundary = "http_request", lower) {
  unwrap(bend.check_json(list(bytes), boundary, context(lower)));
}
export function readHttpRequest(exchange, incoming, lower) {
  return value(
    unwrap(
      bend.read_http_request(
        exchange.operationId,
        json(descriptor(incoming)),
        context(lower),
      ),
    ),
  );
}
export function readHttp(exchange, received, options) {
  return value(
    unwrap(
      bend.read_http(
        exchange.operationId,
        json(descriptor(received)),
        context(options),
      ),
    ),
  );
}
export function readWssClient(bytes, options) {
  return value(unwrap(bend.read_wss_client(list(bytes), context(options))));
}
export function readWssServer(bytes, options) {
  return value(unwrap(bend.read_wss_server(list(bytes), context(options))));
}
export function writeWssClient(frame, options) {
  return Uint8Array.from(
    array(unwrap(bend.write_wss_client(json(frame), context(options)))),
  );
}
export function writeWssServer(frame, options) {
  return Uint8Array.from(
    array(unwrap(bend.write_wss_server(json(frame), context(options)))),
  );
}
export function correlation(headers) {
  return value(
    bend.correlation(
      json(
        [...headers.entries()].map(([name, content]) => ({
          name,
          value: content,
        })),
      ),
    ),
  );
}

function schema(name) {
  return {
    name,
    parse(input) {
      return readJson(
        contract(this),
        new TextEncoder().encode(JSON.stringify(value(json(input)))),
      );
    },
    safeParse(input) {
      try {
        return { success: true, data: this.parse(input) };
      } catch (error) {
        return { success: false, error };
      }
    },
  };
}

const names = value(bend.schema_names());
const schemas = Object.fromEntries(names.map((name) => [name, schema(name)]));
export const exchanges = Object.fromEntries(
  value(bend.exchange_catalog()).map((entry) => [
    entry.operationId,
    {
      ...entry,
      request: contract(schema(`Request.${entry.operationId}`)),
      response: contract(
        schema(`Response.${entry.operationId}`),
        "http_response",
      ),
    },
  ]),
);
export const inputSections = Object.fromEntries(
  value(bend.section_names()).map((name) => [
    name,
    schema(`InputSection.${name}`),
  ]),
);
export const readSections = Object.fromEntries(
  value(bend.section_names()).map((name) => [
    name,
    schema(`ReadSection.${name}`),
  ]),
);
export const budgets = value(bend.budget_catalog());
export const commandCatalog = Object.fromEntries(
  ["move_to", "pause", "resume"].map((name) => [
    name,
    schema(`Command.${name}`),
  ]),
);
export const wss = {
  clientFrame: contract(schemas.ClientFrame, "wss_control"),
  serverFrame: contract(schemas.ServerFrame, "wss_data"),
};
export const protocol = {
  ...schemas,
  PROTOCOL_VERSION,
  ProtocolError,
  contract,
  readJson,
  writeJson,
  checkJsonBytes,
  readHttpRequest,
  readHttp,
  readWssClient,
  readWssServer,
  writeWssClient,
  writeWssServer,
  correlation,
  exchanges,
  inputSections,
  readSections,
  budgets,
  commandCatalog,
  wss,
};
