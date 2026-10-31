#!/usr/bin/env node
import { failure, help, parseArgv, perform, versionText } from './command.js';
import { releaseMetadata } from './release.js';

const controller = new AbortController();
const cancel = () => controller.abort();
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
process.on('SIGHUP', cancel);
try {
  const launch = await parseArgv(process.argv.slice(2));
  if ('screen' in launch) {
    if (launch.screen === 'help') process.stdout.write(help);
    else if (launch.screen === 'version')
      process.stdout.write(versionText(await releaseMetadata()));
    else {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('terminal_required');
      const { openTui } = await import('./tui.js');
      process.exitCode = await openTui(launch.root, controller);
    }
  } else {
    const result = await perform(launch, controller.signal);
    process.stdout.write(JSON.stringify(result.envelope) + '\n');
    process.exitCode = result.exitCode;
  }
} catch (error) {
  const result = failure(error);
  process.stdout.write(JSON.stringify(result.envelope) + '\n');
  process.exitCode = result.exitCode;
}
