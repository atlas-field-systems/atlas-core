import { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useInput } from 'ink';
import { Select, TextInput, PasswordInput, ConfirmInput, Spinner, StatusMessage } from '@inkjs/ui';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { exchanges } from '@atlas/protocol';
import { perform, failure } from '../src/command.js';
import type { Operation, CommandResult } from '../src/command.js';
import { defaults } from '../src/settings.js';
import {
  commonField,
  edited,
  effects,
  endpoint,
  isCommonSetting,
  settingRows,
  settingsLines,
  summarize,
  viewOf,
} from './tui-view.js';
import type { Choice, CommonSetting, Receipt, View } from './tui-view.js';

type Field = {
  name: string;
  label: string;
  problem: string;
  initial?: string;
  secret?: boolean;
  options?: readonly string[];
  check: (value: string) => unknown;
};
type Form = {
  fields: Field[];
  values: Record<string, string>;
  index: number;
  finish: (values: Record<string, string>) => Operation;
};
type Page = 'home' | 'settings' | 'diagnostics';
type Screen =
  | { kind: Page }
  | { kind: 'form'; form: Form; back: Page }
  | { kind: 'confirm'; operation: Operation; back: Page }
  | { kind: 'busy'; back: Page; cancelling: boolean };
const absolute = (value: string | undefined) => z.string().startsWith('/').max(4096).parse(value);
const pathField = (name: string, label: string): Field => ({
  name,
  label,
  problem: 'Enter an absolute path.',
  check: absolute,
});
const tlsFields = [
  pathField('certificate', 'Absolute certificate PEM path'),
  pathField('key', 'Absolute private key PEM path'),
];
function credentialDraft() {
  const ids = { api_key_id: randomUUID(), request_id: randomUUID() };
  const credential = (secret: string | undefined) =>
    exchanges.CreateApiKey.request.schema.parse({ ...ids, secret });
  const field: Field = {
    name: 'secret',
    label: '32-byte base64url secret (masked)',
    problem: 'Enter a 32-byte base64url secret.',
    secret: true,
    check: credential,
  };
  return { credential, field };
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
  const [screen, setScreen] = useState<Screen>({ kind: 'busy', back: 'home', cancelling: false });
  const [view, setView] = useState<View>();
  const [problem, setProblem] = useState('');
  const [receipt, setReceipt] = useState<Receipt>();
  const owned = useRef<Promise<void> | undefined>(undefined);
  const operationController = useRef<AbortController>();
  const failed = useRef(false);
  const refresh = async () => {
    const read = (kind: 'inspect' | 'settings-show' | 'tls-show') =>
      perform({ root, operation: { effect: 'read', command: { kind } } }).catch(failure);
    const inspect = await read('inspect');
    const settings = await read('settings-show');
    const tls = await read('tls-show');
    setView(viewOf(root, { inspect, settings, tls }));
  };
  const own = (back: Page, work: (signal: AbortSignal) => Promise<void>) => {
    if (controller.signal.aborted) return;
    const active = new AbortController();
    operationController.current = active;
    setScreen({ kind: 'busy', back, cancelling: false });
    owned.current = (async () => {
      await work(active.signal);
      if (!controller.signal.aborted) await refresh();
      setScreen((current) => (current.kind === 'busy' ? { kind: current.back } : current));
    })()
      .catch((error: unknown) => {
        failed.current = true;
        const line = `Status refresh failed: ${String(failure(error).envelope.code)}`;
        setReceipt((last) => ({
          tone: 'error',
          headline: last?.headline ?? 'Status refresh failed.',
          lines: [...(last?.lines ?? []), line],
        }));
        setScreen({ kind: 'home' });
      })
      .finally(() => {
        if (operationController.current === active) operationController.current = undefined;
      });
  };
  const run = (operation: Operation, back: Page) =>
    own(back, async (signal) => {
      setReceipt(undefined);
      const result: CommandResult = await perform({ root, operation }, signal).catch(failure);
      if (result.exitCode === 1) failed.current = true;
      setReceipt(summarize(root, operation, result));
    });
  const load = (page: Page) => own(page, async () => {});
  useEffect(() => {
    let closing = false;
    const settle = () => {
      if (closing) return;
      closing = true;
      operationController.current?.abort();
      setScreen((current) =>
        current.kind === 'busy' ? { ...current, cancelling: true } : current,
      );
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
    load('home');
    if (controller.signal.aborted) settle();
    return () => controller.signal.removeEventListener('abort', settle);
  }, []);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') controller.abort();
    if (!key.escape) return;
    setProblem('');
    if (screen.kind === 'busy') {
      operationController.current?.abort();
      setScreen((current) =>
        current.kind === 'busy' ? { ...current, back: 'home', cancelling: true } : current,
      );
    } else if (screen.kind === 'form' || screen.kind === 'confirm')
      setScreen({ kind: screen.back });
    else setScreen({ kind: 'home' });
  });
  const page: Page =
    screen.kind === 'settings' || screen.kind === 'diagnostics' ? screen.kind : 'home';
  const confirm = (operation: Operation, back = page) =>
    setScreen({ kind: 'confirm', operation, back });
  const form = (fields: Field[], complete: Form['finish']) =>
    setScreen({
      kind: 'form',
      form: { fields, finish: complete, values: {}, index: 0 },
      back: page,
    });
  const editSetting = (key: CommonSetting) => {
    const current = view?.settings;
    if (!current) return;
    const { revision, saved } = current;
    form(
      [{ ...commonField(key, saved), check: (value) => edited(saved, key, value) }],
      (values) => ({
        effect: 'write',
        command: {
          kind: 'settings-save',
          expectedRevision: revision,
          settings: edited(saved, key, values[key]),
        },
      }),
    );
  };
  const choose = (choice: Choice | CommonSetting) => {
    setProblem('');
    if (isCommonSetting(choice)) {
      editSetting(choice);
      return;
    }
    switch (choice) {
      case 'Exit':
        finish(failed.current ? 1 : 0);
        return;
      case 'Back':
        setScreen({ kind: 'home' });
        return;
      case 'Diagnostics':
        setScreen({ kind: 'diagnostics' });
        return;
      case 'Settings':
        load('settings');
        return;
      case 'Refresh status':
        load(page);
        return;
      case 'Check installation':
        run({ effect: 'read', command: { kind: 'doctor' } }, page);
        return;
      case 'Set up Core': {
        const { credential, field } = credentialDraft();
        const listen = ['host', 'port', 'trustedOrigins'] as const;
        form(
          [
            ...tlsFields,
            field,
            ...listen.map((key) => ({
              ...commonField(key, defaults),
              check: (value: string) => edited(defaults, key, value),
            })),
          ],
          (values) => ({
            effect: 'write',
            command: {
              kind: 'setup',
              certificate: absolute(values.certificate),
              key: absolute(values.key),
              credential: credential(values.secret),
              settings: listen.reduce(
                (settings, key) => edited(settings, key, values[key]),
                defaults,
              ),
            },
          }),
        );
        return;
      }
      case 'Add credential': {
        const { credential, field } = credentialDraft();
        form([field], (values) => ({
          effect: 'write',
          command: { kind: 'provision', credential: credential(values.secret) },
        }));
        return;
      }
      case 'Replace certificate':
        form(tlsFields, (values) => ({
          effect: 'write',
          command: {
            kind: 'tls-replace',
            certificate: absolute(values.certificate),
            key: absolute(values.key),
            restart: false,
          },
        }));
        return;
      case 'Export diagnostics':
        form(
          [pathField('out', 'Absolute new diagnostic export path (must not exist)')],
          (values) => ({ effect: 'write', command: { kind: 'export', out: absolute(values.out) } }),
        );
        return;
      case 'Start Core':
        confirm({ effect: 'write', command: { kind: 'start' } });
        return;
      case 'Stop Core':
        confirm({ effect: 'write', command: { kind: 'stop', force: false } });
        return;
      case 'Restart Core':
        confirm({ effect: 'write', command: { kind: 'restart' } });
        return;
    }
  };
  const menu = (options: { label: string; value: Choice | CommonSetting }[]) => (
    <Select
      key={screen.kind}
      options={options}
      visibleOptionCount={options.length}
      onChange={(value) => {
        const selected = options.find((option) => option.value === value);
        if (selected) choose(selected.value);
      }}
    />
  );
  const actions = (choices: readonly Choice[]) => choices.map((value) => ({ label: value, value }));
  let content;
  if (screen.kind === 'home') content = menu(actions(view?.actions ?? ['Refresh status', 'Exit']));
  else if (screen.kind === 'diagnostics')
    content = menu(actions(['Check installation', 'Export diagnostics', 'Back']));
  else if (screen.kind === 'busy')
    content = (
      <Spinner
        label={
          screen.cancelling
            ? 'Cancellation requested. Awaiting operation and cleanup.'
            : 'Working. Awaiting operation and cleanup.'
        }
      />
    );
  else if (screen.kind === 'confirm')
    content = (
      <>
        <Text>{effects(screen.operation)}</Text>
        <Text>Apply to the installation and endpoint shown above? [y/N]</Text>
        <ConfirmInput
          defaultChoice="cancel"
          onConfirm={() => run(screen.operation, screen.back)}
          onCancel={() => setScreen({ kind: screen.back })}
        />
      </>
    );
  else if (screen.kind === 'form') {
    const field = screen.form.fields[screen.form.index];
    const submit = (value: string) => {
      if (!field) return;
      try {
        if (value.length > 65_536) throw new Error('record_limit');
        field.check(value);
      } catch {
        setProblem(field.problem);
        return;
      }
      setProblem('');
      const values = { ...screen.form.values, [field.name]: value };
      if (screen.form.index + 1 < screen.form.fields.length)
        setScreen({ ...screen, form: { ...screen.form, values, index: screen.form.index + 1 } });
      else {
        try {
          confirm(screen.form.finish(values), screen.back);
        } catch {
          setProblem('Invalid settings. Escape discards this form.');
        }
      }
    };
    content = field ? (
      <Box flexDirection="column" key={field.name}>
        <Text>{field.label}</Text>
        {field.secret ? (
          <PasswordInput onSubmit={submit} />
        ) : field.options ? (
          <Select
            options={field.options.map((value) => ({ label: value, value }))}
            visibleOptionCount={field.options.length}
            onChange={submit}
          />
        ) : (
          <TextInput defaultValue={field.initial ?? ''} onSubmit={submit} />
        )}
      </Box>
    ) : null;
  } else {
    const apply: Choice[] =
      view?.phase === 'running'
        ? ['Restart Core']
        : view?.phase === 'stopped'
          ? ['Start Core']
          : [];
    content = (
      <>
        {settingsLines(view ?? { settings: null, tls: null }).map((line) => (
          <Text key={line}>{line}</Text>
        ))}
        {menu([
          ...(view?.settings ? settingRows(view.settings) : []),
          ...actions([...apply, 'Replace certificate', 'Back']),
        ])}
      </>
    );
  }
  const candidate = screen.kind === 'confirm' ? screen.operation.command : undefined;
  const candidateSettings =
    candidate?.kind === 'setup' || candidate?.kind === 'settings-save'
      ? candidate.settings
      : undefined;
  const saved = view?.settings?.saved;
  const shownEndpoint = candidateSettings
    ? `Proposed ${endpoint(candidateSettings)}`
    : saved
      ? `Saved ${endpoint(saved)}`
      : 'Endpoint unavailable';
  return (
    <Box flexDirection="column">
      <Text bold>Atlas Core</Text>
      <Text>Installation {root}</Text>
      <Text>{view?.status ?? 'Inspecting installation'}</Text>
      <Text>{shownEndpoint}</Text>
      {view?.notes.map((note) => (
        <Text key={note}>{note}</Text>
      ))}
      <Text dimColor>
        Escape returns. Ctrl-C waits for owned work. Closing leaves Core running.
      </Text>
      {problem ? <StatusMessage variant="error">{problem}</StatusMessage> : null}
      {receipt ? (
        <Box flexDirection="column">
          <StatusMessage variant={receipt.tone}>{receipt.headline}</StatusMessage>
          {receipt.lines.map((line) => (
            <Text key={line}>{line}</Text>
          ))}
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
