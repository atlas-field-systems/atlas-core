// Elevation Lookup: an example Plugin implementing protocol/plugin-container.md.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

import { AtlasClient } from "@atlas-field-systems/sdk";

/** Largest request body the Plugin accepts from Core. */
const maxBodyBytes = 4096;

const env = requireEnvironment(["ATLAS_PLUGIN_ID", "ATLAS_PLUGIN_KEY", "ATLAS_DISPATCH_SECRET", "ATLAS_CORE_URL", "ATLAS_PLUGIN_PORT"]);
const manifest = JSON.parse(await readFile(new URL("./atlas-plugin.json", import.meta.url), "utf8"));
const samples = JSON.parse(await readFile(new URL("./data.json", import.meta.url), "utf8"));
const core = new AtlasClient({ baseUrl: env.ATLAS_CORE_URL, apiKey: env.ATLAS_PLUGIN_KEY });
const accepted = new Set();
let admitting = true;

/** Looks up an exact sample; there is no interpolation. */
function lookup({ latitude, longitude }) {
  const point = samples.points.find((sample) => sample.latitude === latitude && sample.longitude === longitude);
  if (!point) return { status: "failed", output: { latitude, longitude }, error: "No elevation sample exists at this coordinate." };
  return { status: "completed", output: { latitude, longitude, elevation: point.elevation, units: samples.units, reference: samples.reference } };
}

async function perform(id, input) {
  try {
    await core.reportOperation(env.ATLAS_PLUGIN_ID, id, lookup(input));
  } catch (error) {
    console.error(`Could not report Operation ${id}:`, error);
  }
}

const routes = {
  "GET /health": () => [200, { id: manifest.id, release: manifest.release, capabilities: manifest.capabilities.map((capability) => capability.name) }],
  "POST /operations": ({ id, input }) => {
    if (!admitting) return [503];
    if (!accepted.has(id)) {
      accepted.add(id);
      setImmediate(() => perform(id, input));
    }
    return [202];
  },
  // Lookups finish immediately, so there is never running work to cancel.
  "POST /cancel": () => [202],
  "POST /quiesce": () => {
    admitting = false;
    return [204];
  },
};

createServer(async (request, response) => {
  const route = routeOf(request);
  if (!routes[route]) return response.writeHead(404).end();
  if (route !== "GET /health" && request.headers.authorization !== `Bearer ${env.ATLAS_DISPATCH_SECRET}`) return response.writeHead(401).end();
  try {
    const [status, body] = routes[route](await readJson(request));
    response.writeHead(status, body ? { "Content-Type": "application/json" } : {}).end(body ? JSON.stringify(body) : undefined);
  } catch {
    response.writeHead(400).end();
  }
}).listen(Number(env.ATLAS_PLUGIN_PORT), "0.0.0.0");

function routeOf(request) {
  const path = /^\/operations\/[^/]+\/cancel$/.test(request.url) ? "/cancel" : request.url;
  return `${request.method} ${path}`;
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxBodyBytes) throw new Error("request too large");
  }
  return body ? JSON.parse(body) : {};
}

function requireEnvironment(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing Plugin environment: ${missing.join(", ")}`);
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}
