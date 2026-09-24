// A test Plugin implementing protocol/plugin-container.md, with controls
// scenarios use to hold work, inspect it and refuse to stop. Never shipped.
//
// Input: { label, hold?, fail?, ignore_cancel? }. Held work reports
// in_progress and waits for POST /fixture/release or, unless ignore_cancel,
// a cancellation; `fail` makes it fail with that error. While admitting, the fixture also "ingests" continuously, counting
// ticks, until quiesced.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

import { AtlasClient } from "../../../../sdk/dist/index.js";

/** Interval of the continuous ingestion a planned stop must pause. */
const ingestionTickMs = 20;

const env = process.env;
const manifest = JSON.parse(await readFile(new URL("./atlas-plugin.json", import.meta.url), "utf8"));
const core = new AtlasClient({ baseUrl: env.ATLAS_CORE_URL, apiKey: env.ATLAS_PLUGIN_KEY });
const held = new Map();
const accepted = new Set();
const canceledEarly = new Set();
const ignoringCancel = new Set();
const state = { admitting: true, ingested: 0, refuseQuiesce: false };
const ingestion = setInterval(() => { state.ingested++; }, ingestionTickMs);

async function perform(id, input) {
  if (canceledEarly.delete(id)) return report(id, { status: "canceled", output: { label: input.label, stage: "canceled" } });
  if (input.hold) {
    await report(id, { status: "in_progress", output: { label: input.label, stage: "held" } });
    const released = await new Promise((resolve) => held.set(id, resolve));
    held.delete(id);
    if (released === "canceled") return report(id, { status: "canceled", output: { label: input.label, stage: "canceled" } });
  }
  if (input.fail) return report(id, { status: "failed", output: { label: input.label }, error: input.fail });
  return report(id, { status: "completed", output: { label: input.label, stage: "done" } });
}

async function report(id, outcome) {
  try {
    await core.reportOperation(manifest.id, id, outcome);
  } catch (error) {
    console.error(`fixture could not report ${id}:`, error);
  }
}

const contract = {
  "GET /health": () => [200, { id: manifest.id, release: manifest.release, capabilities: manifest.capabilities.map((capability) => capability.name) }],
  "POST /operations": ({ id, input }) => {
    if (!state.admitting) return [503];
    if (!accepted.has(id)) {
      accepted.add(id);
      if (input.ignore_cancel) ignoringCancel.add(id);
      setImmediate(() => perform(id, input));
    }
    return [202];
  },
  "POST /cancel": (_, id) => {
    if (ignoringCancel.has(id)) return [202];
    if (held.has(id)) held.get(id)("canceled");
    else canceledEarly.add(id);
    return [202];
  },
  "POST /quiesce": () => {
    if (state.refuseQuiesce) return [503];
    state.admitting = false;
    clearInterval(ingestion);
    return [204];
  },
};

const controls = {
  "GET /fixture/state": () => [200, { ...state, ingesting: state.admitting, held: held.size }],
  "POST /fixture/release": () => {
    for (const release of held.values()) release("released");
    return [204];
  },
  "POST /fixture/refuse-quiesce": () => {
    state.refuseQuiesce = true;
    return [204];
  },
};

createServer(async (request, response) => {
  const cancel = request.url.match(/^\/operations\/([^/]+)\/cancel$/);
  const route = `${request.method} ${cancel ? "/cancel" : request.url}`;
  const handler = contract[route] ?? controls[route];
  if (!handler) return response.writeHead(404).end();
  if (contract[route] && route !== "GET /health" && request.headers.authorization !== `Bearer ${env.ATLAS_DISPATCH_SECRET}`) return response.writeHead(401).end();
  let body = "";
  for await (const chunk of request) body += chunk;
  const [status, reply] = handler(body ? JSON.parse(body) : {}, cancel?.[1]);
  response.writeHead(status, reply ? { "Content-Type": "application/json" } : {}).end(reply ? JSON.stringify(reply) : undefined);
}).listen(Number(env.ATLAS_PLUGIN_PORT), "0.0.0.0");
