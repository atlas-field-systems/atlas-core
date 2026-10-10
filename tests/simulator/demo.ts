// Local S1 demonstration, runnable outside the test runner:
//
//   python3 scripts/build_core.py
//   node tests/simulator/demo.mjs <empty-directory> [--port PORT]
//
// It uses the same CLI, Core container, SDK and simulator as the S1 tests.
// The installation, its owner-only secret files and the simulated Asset's
// retention file stay in the directory; stop Core with atlas-manage stop.
import { parseArgs } from "node:util";
import { accepted } from "../../Atlas SDK/src/index.js";
import { prepareAsset, ReportingProcess } from "./index.js";
import { Installation, text } from "./installation.js";

const { positionals, values } = parseArgs({ allowPositionals: true, options: { port: { type: "string" } } });
const directory = positionals[0];
if (directory === undefined) throw new Error("usage: demo.mjs <directory> [--port PORT]");
const say = (message: string) => console.log(`- ${message}`);

const installation = await Installation.create(directory, {
  ...(values.port === undefined ? {} : { port: Number(values.port) }),
});
const ca = await installation.ca();
say(`set up installation ${installation.installationId} under ${installation.root}`);
say(`administrator key retained in ${installation.adminKeyFile}; CA exported (${ca.length} bytes PEM)`);
const started = await installation.start();
say(`Core serves ${installation.baseUrl} with Dataset ${text(started.dataset_id, "Dataset")}`);

const operator = await installation.operator();
const discovery = await operator.discover();
say(`operator discovered edition ${discovery.protocolVersion}; Core release ${discovery.coreRelease}`);

const os = await prepareAsset(directory, (assetId, key) => installation.authorizeEnrollment(assetId, key), {
  alias: "Demo Rover",
});
const asset = new ReportingProcess(os, await installation.link());
const registration = await asset.register();
if (registration.outcome !== "accepted") throw new Error(`registration ${registration.outcome}`);
say(`Asset ${os.assetId} enrolled and registered as "Demo Rover" (offline, unknown status)`);

const create = async (latitude: number, longitude: number) =>
  accepted(
    await operator.createTask(
      await operator.prepareTaskCreation({
        assetId: os.assetId,
        input: { command: "move_to", target: { kind: "position", position: { latitude, longitude } } },
      }),
    ),
  );
const first = await create(10, 20);
const second = await create(10.001, 20);
say(`issued two queued Move To Tasks while the Asset is offline: ${first.id}, ${second.id}`);

const claim = await asset.establish({ components: { telemetry: { position: { latitude: 10.0003, longitude: 20 } } } });
if (claim.outcome !== "accepted") throw new Error(`process authority ${claim.outcome}`);
say(`Asset established process generation ${claim.value.report?.authority?.process_generation ?? "?"}`);

const work = await asset.receiveWork();
say(`Asset received ${work.tasks.length} outstanding Tasks in requested order`);
await asset.capture(await os.startNext());
for (const remaining of [12.5, 5.1, 4.9]) await asset.capture(await os.progress(first.id, remaining));
await asset.capture(await os.complete(first.id));
await asset.flush();
say(`first Task ${(await operator.getTask(first.id)).status} after progress 12.5, 5.1 and 4.9 m`);

const cancellation = await operator.requestCancellation(await operator.prepareCancellation({ taskId: second.id }));
say(`operator requested cancellation of the second Task: ${accepted(cancellation).status}`);
const pending = (await asset.receiveWork()).tasks.find((task) => task.id === second.id);
const request = pending?.cancellations.find((candidate) => candidate.state === "requested");
if (request === undefined) throw new Error("the cancellation request was not delivered");
await asset.capture(await os.decideCancellation(second.id, request.cancellation_id, true));
await asset.flush();
say(`second Task ${(await operator.getTask(second.id)).status} after the Asset confirmed`);

const history = await operator.movementHistory(os.assetId);
say(`movement history holds ${history.items.length} sample(s)`);
await installation.restart();
say(`after Restart the first Task is still ${(await operator.getTask(first.id)).status}`);
await installation.stop();
say("Core stopped; the installation and its Dataset remain in the directory");
