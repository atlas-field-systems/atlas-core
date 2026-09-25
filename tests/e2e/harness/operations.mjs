import { eventually } from "./barriers.mjs";

/** Installs a Plugin as a process, starts Core, and waits until the Plugin is available. */
export async function startWithPlugin(s, pluginDir) {
  const installation = await s.installation();
  const plugin = await s.installPlugin(installation, pluginDir);
  const core = await s.startCore(installation);
  const process = await s.startPlugin(plugin, core);
  const operator = s.client(core, installation.operatorKey);
  await s.transcript.unrecorded(() => eventually(async () => (await operator.plugin(plugin.id)).availability === "available", `${plugin.id} available`));
  return { installation, plugin, core, process, operator };
}

/** Prepares a submission and names its ID in the transcript. */
export async function prepare(s, client, capability, input, label = "submission") {
  const submission = await client.prepareOperation(capability, input);
  s.transcript.name(submission.submission_id, label);
  return submission;
}
