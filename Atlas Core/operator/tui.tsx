import { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useInput } from 'ink';
import { Select, TextInput, PasswordInput, ConfirmInput, Spinner, StatusMessage } from '@inkjs/ui';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Uuid, exchanges } from '@atlas/protocol';
import { perform, failure } from '../src/command.js';
import type { Operation, CommandResult } from '../src/command.js';
import { defaults, Settings } from '../src/settings.js';
import { SavedSettings } from '../src/installation.js';

type Field = { name: string; label: string; initial?: string; secret?: boolean };
type Form = {
  fields: Field[];
  values: Record<string, string>;
  index: number;
  finish: (values: Record<string, string>) => Operation;
};
type Screen =
  | { kind: 'home' }
  | { kind: 'form'; form: Form }
  | { kind: 'confirm'; operation: Operation }
  | { kind: 'busy' }
  | { kind: 'result'; result: CommandResult }
  | {
      kind: 'settings';
      settings: Settings;
      revision: string;
      effective: Settings | null;
      applyFailure: string | null;
    };
const choices = [
  'Setup',
  'Inspect',
  'Doctor',
  'Start',
  'Stop',
  'Force Stop',
  'Restart',
  'Settings',
  'Apply settings with restart',
  'TLS status',
  'Replace TLS',
  'Replace TLS and restart',
  'Provision credential',
  'Enroll Asset',
  'Inspect enrollment',
  'Revoke enrollment',
  'Export diagnostics',
  'Recover',
  'Reset',
  'Hard Reset',
  'Update',
  'Exit',
];
const credentialFields = (): Field[] => [
  { name: 'api_key_id', label: 'API key UUID', initial: randomUUID() },
  { name: 'request_id', label: 'Request UUID', initial: randomUUID() },
  { name: 'secret', label: '32-byte base64url secret (masked)', secret: true },
];
const tlsFields: Field[] = [
  { name: 'certificate', label: 'Absolute certificate PEM path' },
  { name: 'key', label: 'Absolute private key PEM path' },
];
const absolute = (value: string | undefined) => z.string().startsWith('/').max(4096).parse(value);
function leaves(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, item]) =>
    leaves(item, prefix ? `${prefix}.${key}` : key),
  );
}
function valueAt(value: unknown, path: string): unknown {
  for (const key of path.split('.')) value = z.record(z.string(), z.unknown()).parse(value)[key];
  return value;
}
function changed(value: unknown, path: string[], replacement: unknown): unknown {
  const [key, ...rest] = path;
  if (!key) return replacement;
  const record = z.record(z.string(), z.unknown()).parse(value);
  return { ...record, [key]: changed(record[key], rest, replacement) };
}
function App({
  root,
  controller,
  finish,
}: {
  root: string;
  controller: AbortController;
  finish: (code: 0 | 1 | 130) => void;
}) {
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });
  const [state, setState] = useState('Inspecting installation');
  const [endpoint, setEndpoint] = useState('Endpoint unavailable before setup');
  const [problem, setProblem] = useState('');
  const [lastResult, setLastResult] = useState<CommandResult>();
  const owned = useRef<Promise<void> | undefined>(undefined);
  const operationController = useRef<AbortController>();
  const failed = useRef(false);
  const refresh = async () => {
    const result = await perform({
      root,
      operation: { effect: 'read', command: { kind: 'inspect' } },
    });
    if (result.exitCode !== 0) setState('State unavailable. Inspect or Doctor provides details.');
    const snapshot = z
      .object({ running: z.boolean(), setup_required: z.boolean().optional() })
      .safeParse(result.envelope.data);
    setState(
      snapshot.success
        ? snapshot.data.setup_required
          ? 'Setup required'
          : snapshot.data.running
            ? 'Running. Inspect reports readiness.'
            : 'Stopped'
        : 'State unavailable',
    );
    const settings = await perform({
      root,
      operation: { effect: 'read', command: { kind: 'settings-show' } },
    });
    const saved = z.object({ saved: Settings }).safeParse(settings.envelope.data);
    if (saved.success) setEndpoint(`https://${saved.data.saved.host}:${saved.data.saved.port}`);
  };
  useEffect(() => {
    let closing = false;
    const settle = () => {
      if (closing) return;
      closing = true;
      operationController.current?.abort();
      void (async () => {
        try {
          await owned.current;
        } catch {
          failed.current = true;
        }
        finish(failed.current ? 1 : 130);
      })();
    };
    controller.signal.addEventListener('abort', settle, { once: true });
    owned.current = refresh();
    if (controller.signal.aborted) settle();
    return () => controller.signal.removeEventListener('abort', settle);
  }, []);
  const run = (operation: Operation) => {
    if (controller.signal.aborted) return;
    const active = new AbortController();
    operationController.current = active;
    setScreen({ kind: 'busy' });
    owned.current = (async () => {
      const result = await perform({ root, operation }, active.signal);
      setLastResult(result);
      if (result.exitCode === 1) failed.current = true;
      await refresh();
      if (!controller.signal.aborted) setScreen({ kind: 'result', result });
    })().catch((error: unknown) => {
      failed.current = true;
      const result = failure(error);
      setLastResult(result);
      setScreen({ kind: 'result', result });
    }).finally(() => {
      if (operationController.current === active) operationController.current = undefined;
    });
  };
  useInput((input, key) => {
    if (key.ctrl && input === 'c') controller.abort();
    if (key.escape) {
      if (screen.kind === 'busy') {
        operationController.current?.abort();
        void owned.current?.then(
          () => {
            if (!controller.signal.aborted) setScreen({ kind: 'home' });
          },
          (error: unknown) => {
            failed.current = true;
            const result = failure(error);
            setLastResult(result);
            if (!controller.signal.aborted) setScreen({ kind: 'result', result });
          },
        );
      }
      else {
        setProblem('');
        setScreen({ kind: 'home' });
      }
    }
  });
  const confirm = (operation: Operation) => setScreen({ kind: 'confirm', operation });
  const saveSettingsOperation = (settings: Settings, expectedRevision: string): Operation => {
    return { effect: 'write', command: { kind: 'settings-save', expectedRevision, settings } };
  };
  const form = (fields: Field[], complete: Form['finish']) =>
    setScreen({ kind: 'form', form: { fields, finish: complete, values: {}, index: 0 } });
  const choose = (choice: string) => {
    setProblem('');
    const read = (kind: 'inspect' | 'doctor' | 'tls-show' | 'enrollment-inspect') =>
      run({ effect: 'read', command: { kind } });
    switch (choice) {
      case 'Exit':
        finish(failed.current ? 1 : 0);
        return;
      case 'Inspect':
        read('inspect');
        return;
      case 'Doctor':
        read('doctor');
        return;
      case 'TLS status':
        read('tls-show');
        return;
      case 'Inspect enrollment':
        read('enrollment-inspect');
        return;
      case 'Setup':
        form(
          [
            ...tlsFields,
            ...credentialFields(),
            { name: 'host', label: 'HTTPS bind address', initial: defaults.host },
            { name: 'port', label: 'HTTPS port', initial: String(defaults.port) },
            { name: 'origins', label: 'Trusted browser origins as JSON array', initial: '[]' },
          ],
          (v) => {
            const settings = Settings.parse({
              ...defaults,
              host: v.host,
              port: Number(v.port),
              trustedOrigins: JSON.parse(v.origins ?? '[]'),
            });
            return {
              effect: 'write',
              command: {
                kind: 'setup',
                certificate: absolute(v.certificate),
                key: absolute(v.key),
                credential: exchanges.CreateApiKey.request.schema.parse({
                  api_key_id: v.api_key_id,
                  request_id: v.request_id,
                  secret: v.secret,
                }),
                settings,
              },
            };
          },
        );
        return;
      case 'Provision credential':
        form(
          [...credentialFields(), { name: 'operator_id', label: 'Operator UUID (optional)' }],
          (v) => {
            const { operator_id, ...credential } = v;
            return {
              effect: 'write',
              command: {
                kind: 'provision',
                credential: exchanges.CreateApiKey.request.schema.parse({
                  ...credential,
                  ...(operator_id ? { operator_id } : {}),
                }),
              },
            };
          },
        );
        return;
      case 'Enroll Asset':
        form(
          [
            { name: 'dataset', label: 'Current Dataset UUID' },
            ...[
              'asset_id',
              'registration_id',
              'request_id',
              'process_generation',
              'api_key_id',
            ].map((name) => ({ name, label: name, initial: randomUUID() })),
            { name: 'secret', label: 'Asset secret (masked)', secret: true },
            { name: 'alias', label: 'Alias (optional)' },
            ...['description', 'type', 'capabilities'].map((name) => ({
              name,
              label: `${name} as JSON (optional)`,
            })),
          ],
          (v) => {
            const { dataset, alias, description, type, capabilities, ...request } = v;
            return {
              effect: 'write',
              command: {
                kind: 'enroll',
                dataset: Uuid.parse(dataset),
                request: exchanges.RegisterAsset.request.schema.parse({
                  ...request,
                  ...(alias ? { alias } : {}),
                  ...(description ? { description: JSON.parse(description) } : {}),
                  ...(type ? { type: JSON.parse(type) } : {}),
                  ...(capabilities ? { capabilities: JSON.parse(capabilities) } : {}),
                }),
              },
            };
          },
        );
        return;
      case 'Revoke enrollment':
        form(
          [
            { name: 'binding', label: 'Binding UUID' },
            { name: 'apiKey', label: 'API key UUID' },
          ],
          (v) => ({
            effect: 'write',
            command: {
              kind: 'enrollment-revoke',
              binding: Uuid.parse(v.binding),
              apiKey: Uuid.parse(v.apiKey),
            },
          }),
        );
        return;
      case 'Replace TLS':
      case 'Replace TLS and restart':
        form(tlsFields, (v) => ({
          effect: 'write',
          command: {
            kind: 'tls-replace',
            certificate: absolute(v.certificate),
            key: absolute(v.key),
            restart: choice.endsWith('restart'),
          },
        }));
        return;
      case 'Export diagnostics':
        form(
          [{ name: 'out', label: 'Absolute new diagnostic export path (must not exist)' }],
          (v) => ({ effect: 'write', command: { kind: 'export', out: absolute(v.out) } }),
        );
        return;
      case 'Settings': {
        setScreen({ kind: 'busy' });
        owned.current = (async () => {
          const result = await perform({
            root,
            operation: { effect: 'read', command: { kind: 'settings-show' } },
          });
          const parsed = z
            .object({
              revision: SavedSettings.shape.revision,
              saved: Settings,
              effective: SavedSettings.shape.effective,
              apply_failure: SavedSettings.shape.apply_failure,
            })
            .safeParse(result.envelope.data);
          if (parsed.success)
            setScreen({
              kind: 'settings',
              settings: parsed.data.saved,
              revision: parsed.data.revision,
              effective: parsed.data.effective?.value ?? null,
              applyFailure: parsed.data.apply_failure,
            });
          else setScreen({ kind: 'result', result });
        })();
        return;
      }
      case 'Start':
        confirm({ effect: 'write', command: { kind: 'start' } });
        return;
      case 'Force Stop':
        confirm({ effect: 'write', command: { kind: 'stop', force: true } });
        return;
      case 'Stop':
        confirm({ effect: 'write', command: { kind: 'stop', force: false } });
        return;
      case 'Restart':
        confirm({ effect: 'write', command: { kind: 'restart' } });
        return;
      case 'Apply settings with restart':
        confirm({ effect: 'write', command: { kind: 'settings-apply' } });
        return;
      case 'Recover':
        confirm({ effect: 'write', command: { kind: 'recover' } });
        return;
      case 'Reset':
        confirm({ effect: 'write', command: { kind: 'reset' } });
        return;
      case 'Hard Reset':
        confirm({ effect: 'write', command: { kind: 'hard-reset' } });
        return;
      case 'Update':
        confirm({ effect: 'write', command: { kind: 'update' } });
        return;
    }
  };
  let content;
  if (screen.kind === 'home')
    content = (
      <Select
        options={choices.map((value) => ({ label: value, value }))}
        visibleOptionCount={8}
        onChange={choose}
      />
    );
  else if (screen.kind === 'busy')
    content = (
      <Spinner
        label={
          controller.signal.aborted
            ? 'Cancellation requested. Awaiting operation and cleanup.'
            : 'Working. Awaiting operation and cleanup.'
        }
      />
    );
  else if (screen.kind === 'confirm') {
    const kind = screen.operation.command.kind;
    const effects =
      kind === 'hard-reset'
        ? 'DESTROYS all Atlas data, credentials and trust.'
        : kind === 'reset' || kind === 'update'
          ? 'DESTROYS operational data and establishes a new Dataset. Core remains stopped.'
          : kind === 'recover'
            ? 'Reconciles interrupted work. Does not retry uncertain work or start Core.'
            : kind === 'enrollment-revoke'
              ? 'Revokes this binding and credential.'
              : kind === 'setup'
                ? 'Creates retained setup and provisions credentials. Core remains stopped.'
                : 'Changes retained setup or service state. Saved TLS and settings activate on explicit start or restart.';
    content = (
      <>
        <Text>
          {kind}. {effects}
        </Text>
        <Text>Apply to the installation and endpoint shown above? [y/N]</Text>
        <ConfirmInput
          defaultChoice="cancel"
          onConfirm={() => run(screen.operation)}
          onCancel={() => setScreen({ kind: 'home' })}
        />
      </>
    );
  } else if (screen.kind === 'form') {
    const field = screen.form.fields[screen.form.index];
    const submit = (value: string) => {
      if (!field) return;
      if (value.length > 65_536) {
        setProblem('Input exceeds the record limit.');
        return;
      }
      const values = { ...screen.form.values, [field.name]: value };
      if (screen.form.index + 1 < screen.form.fields.length)
        setScreen({ kind: 'form', form: { ...screen.form, values, index: screen.form.index + 1 } });
      else {
        try {
          confirm(screen.form.finish(values));
          setProblem('');
        } catch {
          setProblem(
            'Invalid input. Check paths, UUIDs, JSON values and the 32-byte base64url secret. Escape discards this form.',
          );
        }
      }
    };
    content = field ? (
      <Box flexDirection="column" key={field.name}>
        <Text>{field.label}</Text>
        {field.secret ? (
          <PasswordInput onSubmit={submit} />
        ) : (
          <TextInput defaultValue={field.initial ?? ''} onSubmit={submit} />
        )}
      </Box>
    ) : null;
  } else if (screen.kind === 'settings') {
    content = (
      <>
        <Text>
          Saved revision {screen.revision}. Apply failure {screen.applyFailure ?? 'none'}. Choose a
          setting and enter its JSON value. Saving does not activate it.
        </Text>
        <Select
          visibleOptionCount={8}
          options={leaves(screen.settings).map((value) => ({
            value,
            label: `${value} saved=${JSON.stringify(valueAt(screen.settings, value))} effective=${screen.effective === null ? 'unavailable' : JSON.stringify(valueAt(screen.effective, value))}`,
          }))}
          onChange={(path) =>
            form(
              [
                {
                  name: 'value',
                  label: path,
                  initial: JSON.stringify(valueAt(screen.settings, path)),
                },
              ],
              (v) =>
                saveSettingsOperation(
                  Settings.parse(
                    changed(screen.settings, path.split('.'), JSON.parse(v.value ?? 'null')),
                  ),
                  screen.revision,
                ),
            )
          }
        />
      </>
    );
  } else
    content = (
      <>
        <StatusMessage variant={screen.result.exitCode === 1 ? 'error' : 'success'}>
          {screen.result.exitCode === 1
            ? 'Operation failed. Committed effects may remain.'
            : 'Operation completed.'}
        </StatusMessage>
        <Text>{JSON.stringify(screen.result.envelope, null, 2)}</Text>
        <TextInput placeholder="Enter to return" onSubmit={() => setScreen({ kind: 'home' })} />
      </>
    );
  const candidate = screen.kind === 'confirm' ? screen.operation.command : undefined;
  const candidateSettings =
    candidate?.kind === 'setup'
      ? (candidate.settings ?? defaults)
      : candidate?.kind === 'settings-save'
        ? candidate.settings
        : undefined;
  const shownEndpoint = candidateSettings
    ? `Proposed https://${candidateSettings.host}:${candidateSettings.port}`
    : endpoint;
  return (
    <Box flexDirection="column">
      <Text bold>Atlas Core</Text>
      <Text>Installation {root}</Text>
      <Text>{state}</Text>
      <Text>{shownEndpoint}</Text>
      <Text dimColor>
        Escape returns. Ctrl-C waits for owned work before exit. Closing leaves Core running.
      </Text>
      {problem ? <StatusMessage variant="error">{problem}</StatusMessage> : null}
      {screen.kind === 'home' && lastResult ? (
        <Box flexDirection="column">
          <Text>Last operation result</Text>
          <Text>{JSON.stringify(lastResult.envelope, null, 2)}</Text>
        </Box>
      ) : null}
      {content}
    </Box>
  );
}
export async function openTui(root: string, controller: AbortController): Promise<0 | 1 | 130> {
  let resolveExit: (code: 0 | 1 | 130) => void = () => {};
  const settled = new Promise<0 | 1 | 130>((resolve) => {
    resolveExit = resolve;
  });
  const loss = () => controller.abort();
  process.stdin.on('error', loss);
  process.stdin.on('end', loss);
  process.stdin.on('close', loss);
  process.stdout.on('error', loss);
  process.stderr.on('error', loss);
  const app = render(<App root={root} controller={controller} finish={resolveExit} />, {
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    return await settled;
  } finally {
    app.unmount();
    app.cleanup();
    await Promise.all(
      [process.stdout, process.stderr].map(
        (stream) => new Promise<void>((resolve) => stream.write('', () => resolve())),
      ),
    );
    process.stdin.off('error', loss);
    process.stdin.off('end', loss);
    process.stdin.off('close', loss);
    if (!process.stdout.destroyed) process.stdout.off('error', loss);
    if (!process.stderr.destroyed) process.stderr.off('error', loss);
  }
}
