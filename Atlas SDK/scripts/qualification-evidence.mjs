import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const logLimit = 16 * 1024 * 1024;
const captureLimit = 1024 * 1024;

export async function fileEvidence(directory, path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return {
    path: relative(directory, path),
    bytes: (await stat(path)).size,
    sha256: hash.digest('hex'),
  };
}

function sourceState(cwd) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  return {
    revision: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--untracked-files=normal').length !== 0,
  };
}

export async function createQualification(directory, kind, cwd) {
  assert.ok(process.env.npm_execpath, 'Run through npm');
  const report = {
    evidence: {
      version: 1,
      kind,
      source: sourceState(cwd),
      tools: {
        node: process.versions.node,
        npm: execFileSync(process.execPath, [process.env.npm_execpath, '--version'], {
          encoding: 'utf8',
        }).trim(),
      },
      startedAt: new Date().toISOString(),
      status: 'running',
      commands: [],
      files: [],
    },
  };
  const evidence = report.evidence;
  const logs = join(directory, 'evidence');
  await mkdir(logs);
  const save = async () => {
    const path = join(directory, 'qualification.json');
    await writeFile(`${path}.tmp`, JSON.stringify(report, null, 2) + '\n');
    await rename(`${path}.tmp`, path);
  };
  await save();

  async function run(
    name,
    argv,
    { cwd: commandCwd = cwd, env = process.env, expectedExit = 0, capture = false } = {},
  ) {
    assert.ok(
      !evidence.commands.some((command) => command.name === name),
      `Duplicate command ${name}`,
    );
    const command = {
      name,
      argv,
      cwd: commandCwd,
      expectedExit,
      startedAt: new Date().toISOString(),
      status: 'running',
    };
    evidence.commands.push(command);
    await save();
    const prefix = `${String(evidence.commands.length).padStart(2, '0')}-${name}`;
    const child = spawn(argv[0], argv.slice(1), {
      cwd: commandCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let spawnError;
    const closed = new Promise((resolve) => {
      child.once('error', (error) => {
        spawnError = error;
      });
      child.once('close', (exit, signal) => resolve({ exit, signal }));
    });
    let stdout = '';
    let captured = 0;
    async function retain(stream, channel) {
      const path = join(logs, `${prefix}.${channel}.log`);
      const writer = await open(path, 'wx');
      let received = 0;
      try {
        for await (const chunk of stream) {
          const remaining = Math.max(0, logLimit - received);
          if (remaining) await writer.writeFile(chunk.subarray(0, remaining));
          received += chunk.length;
          if (capture && channel === 'stdout') {
            captured += chunk.length;
            if (captured <= captureLimit) stdout += chunk.toString('utf8');
          }
        }
      } finally {
        await writer.close();
      }
      return {
        ...(await fileEvidence(directory, path)),
        closed: true,
        truncated: received > logLimit,
      };
    }
    const retainSafely = (stream, channel) =>
      retain(stream, channel).catch((error) => {
        child.kill('SIGKILL');
        throw error;
      });
    const results = await Promise.allSettled([
      retainSafely(child.stdout, 'stdout'),
      retainSafely(child.stderr, 'stderr'),
      closed,
    ]);
    const outcome = results[2].value;
    Object.assign(command, outcome, { finishedAt: new Date().toISOString() });
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (spawnError) failures.push(spawnError);
    command.logs = results
      .slice(0, 2)
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);
    if (outcome.exit !== expectedExit || outcome.signal)
      failures.push(
        new Error(
          `${name}: exit ${outcome.exit}, signal ${outcome.signal}; expected ${expectedExit}`,
        ),
      );
    if (command.logs.some((log) => log.truncated) || captured > captureLimit)
      failures.push(new Error(`${name}: output exceeded evidence limit`));
    command.status = failures.length ? 'failed' : 'passed';
    if (failures.length) command.error = failures.map(String).join('\n');
    await save();
    if (failures.length) {
      const error = new AggregateError(failures, `${name} failed; logs: ${logs}`);
      error.exitCode = outcome.exit > 0 ? outcome.exit : 1;
      throw error;
    }
    return stdout;
  }

  return {
    report,
    run,
    async artifact(path) {
      evidence.artifact = await fileEvidence(directory, path);
      await save();
    },
    async retain(path) {
      evidence.files.push(await fileEvidence(directory, path));
      await save();
    },
    async finish(error) {
      evidence.sourceAfter = sourceState(cwd);
      evidence.status = error ? 'failed' : 'passed';
      if (error) evidence.error = String(error);
      evidence.finishedAt = new Date().toISOString();
      await save();
      console.log(`Qualification ${evidence.status}: ${join(directory, 'qualification.json')}`);
    },
  };
}
