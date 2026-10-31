import { z } from 'zod';
import type { CommandResult, Operation } from '../src/command.js';
import { Action, SavedSettings } from '../src/installation.js';
import { Settings } from '../src/settings.js';
import { TlsState } from '../src/tls.js';

export type Phase = 'setup' | 'running' | 'stopped' | 'recovery' | 'unknown' | 'unavailable';
export type Choice =
  | 'Set up Core'
  | 'Start Core'
  | 'Stop Core'
  | 'Restart Core'
  | 'Settings'
  | 'Add credential'
  | 'Diagnostics'
  | 'Check installation'
  | 'Export diagnostics'
  | 'Replace certificate'
  | 'Refresh status'
  | 'Back'
  | 'Exit';
const SettingsView = z.object(SavedSettings.shape);
const TlsView = z.object({
  saved: TlsState.shape.saved.optional(),
  active: TlsState.shape.active.optional(),
  activationFailure: TlsState.shape.activationFailure.optional(),
  conversionRequired: z.boolean(),
  recoveryRequired: z.boolean(),
  pendingActivation: z.boolean(),
});
const InspectView = z.object({
  running: z.boolean(),
  setup_required: z.boolean().optional(),
  service: z.object({ ready: z.boolean() }).optional().catch(undefined),
  action: Action.nullish(),
});
export type SettingsView = z.infer<typeof SettingsView>;
type TlsView = z.infer<typeof TlsView>;
export type View = {
  phase: Phase;
  status: string;
  notes: string[];
  actions: Choice[];
  settings: SettingsView | null;
  tls: TlsView | null;
};
export type Receipt = { tone: 'success' | 'warning' | 'error'; headline: string; lines: string[] };

const SafeCode = z.string().regex(/^[a-z_]{1,64}$/);
const Envelope = z.object({
  code: SafeCode.optional(),
  primary_failure: SafeCode.optional(),
  cleanup_failure: SafeCode.optional(),
  failures: z.array(SafeCode).max(8).optional(),
  data: z.unknown().optional(),
});
const DoctorView = z.object({
  checks: z.record(
    z.string(),
    z.object({ status: z.enum(['pass', 'fail', 'unavailable']), instruction: z.string() }),
  ),
});
const Export = z.object({ bytes: z.number().int().nonnegative(), partial: z.boolean() });
const Cancelled = z.object({ cancelled: z.literal(true), committed: z.literal(false) });

const shellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
const recoverCommand = (root: string) => `atlas-core recover --installation ${shellWord(root)}`;
const stopCommand = (root: string) => `atlas-core stop --force --installation ${shellWord(root)}`;
const failureCode = (result: CommandResult) => {
  const envelope = Envelope.safeParse(result.envelope);
  return envelope.success ? envelope.data.code : undefined;
};
const evidence = <T>(result: CommandResult, schema: z.ZodType<T>): T | null => {
  if (result.exitCode !== 0) return null;
  const parsed = schema.safeParse(result.envelope.data);
  return parsed.success ? parsed.data : null;
};
export const endpoint = ({ host, port }: Pick<Settings, 'host' | 'port'>) =>
  `https://${host.includes(':') ? `[${host}]` : host}:${port}`;

const commonKeys = ['host', 'port', 'trustedOrigins', 'diagnosticLevel'] as const;
export type CommonSetting = (typeof commonKeys)[number];
const commonSettings: Record<
  CommonSetting,
  {
    label: string;
    prompt: string;
    problem: string;
    options?: readonly string[];
    show: (settings: Settings) => string;
    parse: (value: string) => Partial<Settings>;
  }
> = {
  host: {
    label: 'Bind address',
    prompt: 'HTTPS bind address',
    problem: 'Enter a host name or IP address.',
    show: (settings) => settings.host,
    parse: (value) => ({ host: value.trim() }),
  },
  port: {
    label: 'HTTPS port',
    prompt: 'HTTPS port',
    problem: 'Enter a port from 0 to 65535.',
    show: (settings) => String(settings.port),
    parse: (value) => {
      if (!/^\d{1,5}$/.test(value.trim())) throw new Error('invalid_port');
      return { port: Number(value) };
    },
  },
  trustedOrigins: {
    label: 'Browser origins',
    prompt: 'Trusted browser origins, comma-separated',
    problem: 'Enter at most 64 origins such as https://console.example:8443, without a path.',
    show: (settings) => settings.trustedOrigins.join(', '),
    parse: (value) => ({ trustedOrigins: value.split(/[,\s]+/).filter(Boolean) }),
  },
  diagnosticLevel: {
    label: 'Diagnostic level',
    prompt: 'Diagnostic level',
    problem: 'Choose a diagnostic level.',
    options: Settings.shape.diagnosticLevel.options,
    show: (settings) => settings.diagnosticLevel,
    parse: (value) => ({ diagnosticLevel: Settings.shape.diagnosticLevel.parse(value) }),
  },
};
export const isCommonSetting = (value: string): value is CommonSetting =>
  commonKeys.some((key) => key === value);
export const commonField = (key: CommonSetting, settings: Settings) => {
  const { prompt, problem, options, show } = commonSettings[key];
  return {
    name: key,
    label: prompt,
    problem,
    initial: show(settings),
    ...(options && { options }),
  };
};
export const edited = (settings: Settings, key: CommonSetting, value: string | undefined) =>
  Settings.parse({ ...settings, ...commonSettings[key].parse(value ?? '') });
const brief = (key: CommonSetting, settings: Settings | undefined) => {
  if (settings === undefined) return 'unavailable';
  if (key !== 'trustedOrigins') return commonSettings[key].show(settings);
  const [first, ...rest] = settings.trustedOrigins;
  if (first === undefined) return 'none';
  return rest.length ? `${first} and ${rest.length} more` : first;
};
export const settingRows = (view: SettingsView) =>
  commonKeys.map((value) => ({
    value,
    label: `${commonSettings[value].label}: ${brief(value, view.saved)}; last verified ${brief(value, view.effective?.value)}`,
  }));

const certificateLines = (tls: TlsView) => [
  `Saved certificate expires ${tls.saved?.notAfter ?? 'unavailable'}.`,
  `Last verified active certificate expires ${tls.active?.notAfter ?? 'unavailable'}.`,
  ...(tls.pendingActivation ? ['Saved certificate is not active.'] : []),
  ...(tls.activationFailure ? [`Certificate activation failed: ${tls.activationFailure}.`] : []),
];
export const settingsLines = ({ settings, tls }: Pick<View, 'settings' | 'tls'>) => [
  ...(settings
    ? [
        `Saved revision ${settings.revision}. Last verified effective revision ${settings.effective?.revision ?? 'unavailable'}.`,
        settings.last_working
          ? `Last working revision ${settings.last_working.revision}: ${endpoint(settings.last_working.value)}.`
          : 'Last working configuration unavailable.',
      ]
    : []),
  ...(tls ? certificateLines(tls) : ['Certificate state unavailable.']),
  'Saved changes apply on the next start or restart. Advanced settings use the CLI.',
];

function recoveryNotes(
  root: string,
  action: z.infer<typeof Action> | null,
  running: boolean,
): string[] {
  const failures = [action?.primary_failure, action?.cleanup_failure].filter(
    (code) => code !== null && code !== undefined,
  );
  const scope =
    action === null
      ? 'finishes the interrupted certificate save'
      : `finishes the interrupted ${action.kind}, which can clear ${action.kind === 'hard-reset' ? 'all Atlas state' : 'operational data'}`;
  return [
    action
      ? `Interrupted ${action.kind} stopped at ${action.phase}.`
      : 'Interrupted certificate save.',
    ...(failures.length ? [`Recorded failures ${failures.join(', ')}.`] : []),
    ...(failures.includes('repair_required')
      ? ['Repair required. Preserve this installation. Do not rerun setup.']
      : [
          `${running ? 'Stop Core, then run' : 'Run'}: ${recoverCommand(root)}`,
          `Recovery ${scope}, and leaves Core stopped. It never retries uncertain work.`,
        ]),
  ];
}
const phaseActions: Record<Phase, Choice[]> = {
  setup: ['Set up Core', 'Check installation', 'Exit'],
  running: [
    'Stop Core',
    'Restart Core',
    'Settings',
    'Add credential',
    'Diagnostics',
    'Refresh status',
    'Exit',
  ],
  stopped: ['Start Core', 'Settings', 'Add credential', 'Diagnostics', 'Refresh status', 'Exit'],
  recovery: ['Check installation', 'Refresh status', 'Exit'],
  unknown: ['Settings', 'Diagnostics', 'Refresh status', 'Exit'],
  unavailable: ['Check installation', 'Refresh status', 'Exit'],
};
function readiness(service: z.infer<typeof InspectView>['service']) {
  if (service === undefined) return 'Running. Readiness unavailable.';
  return service.ready ? 'Running. Ready.' : 'Running. Not ready.';
}
export function viewOf(
  root: string,
  reads: { inspect: CommandResult; settings: CommandResult; tls: CommandResult },
): View {
  const settings = evidence(reads.settings, SettingsView);
  const tls = evidence(reads.tls, TlsView);
  const inspect = evidence(reads.inspect, InspectView);
  const action = inspect?.action && inspect.action.phase !== 'complete' ? inspect.action : null;
  const recovery = action !== null || tls?.recoveryRequired === true;
  const phase: Phase = recovery
    ? 'recovery'
    : inspect?.setup_required
      ? 'setup'
      : inspect?.running === true
        ? 'running'
        : inspect?.running === false
          ? 'stopped'
          : settings
            ? 'unknown'
            : 'unavailable';
  const inspectFailure = failureCode(reads.inspect);
  const status: Record<Phase, string> = {
    setup: 'Setup required',
    running: readiness(inspect?.service),
    stopped: 'Stopped',
    recovery: 'Recovery required',
    unknown: `Status unavailable${inspectFailure ? ` (${inspectFailure})` : ''}`,
    unavailable: `Status unavailable${inspectFailure ? ` (${inspectFailure})` : ''}`,
  };
  const apply =
    phase === 'running' ? ' Restart Core to apply.' : phase === 'stopped' ? ' Start Core.' : '';
  const notes = [
    ...(recovery ? recoveryNotes(root, action, inspect?.running === true) : []),
    ...(settings?.apply_failure === 'apply_required'
      ? [`Saved settings are not active.${apply}`]
      : []),
    ...(settings?.apply_failure === 'start_failed' ? [`Last start failed.${apply}`] : []),
    ...(tls?.pendingActivation && inspect?.setup_required !== true
      ? [`Saved certificate is not active.${apply}`]
      : []),
    ...(tls?.activationFailure ? [`Certificate activation failed: ${tls.activationFailure}.`] : []),
    ...(tls?.conversionRequired && phase !== 'setup' && !recovery && settings
      ? ['Certificate conversion required. Use Settings, then Replace certificate.']
      : []),
    ...(settings?.saved.openEnrollment || settings?.effective?.value.openEnrollment
      ? ['Open enrollment is on. Use the CLI to inspect or change it.']
      : []),
    ...(phase !== 'setup' && settings === null
      ? [`Saved settings unavailable (${failureCode(reads.settings) ?? 'unverified'}).`]
      : []),
  ];
  const actions: Choice[] =
    recovery && inspect?.running
      ? ['Stop Core', ...phaseActions.recovery]
      : phaseActions[phase].filter((choice) => choice !== 'Settings' || settings);
  return { phase, status: status[phase], notes, actions, settings, tls };
}

export function effects(operation: Operation): string {
  const { command } = operation;
  switch (command.kind) {
    case 'setup':
      return 'Set up Core. Creates retained setup and provisions this credential. Core remains stopped.';
    case 'provision':
      return `Add credential. Creates API key ID ${command.credential.api_key_id}.`;
    case 'start':
      return 'Start Core with saved settings and the saved certificate.';
    case 'stop':
      return 'Stop Core. Connections close and data is retained.';
    case 'restart':
      return 'Restart Core. Connections close, data is retained, and saved settings and the saved certificate activate.';
    case 'settings-save':
      return `Save settings over revision ${command.expectedRevision}. Saving does not activate them.`;
    case 'tls-replace':
      return 'Save this certificate. The running service keeps its loaded certificate until restart.';
    case 'export':
      return `Export diagnostics to ${command.out}.`;
    default:
      return 'Change this installation.';
  }
}
function doctorLines(data: unknown): string[] {
  const report = DoctorView.safeParse(data);
  if (!report.success) return ['Check detail unavailable.'];
  const checks = Object.entries(report.data.checks);
  return [
    ...checks
      .filter(([, check]) => check.status !== 'pass')
      .map(([name, check]) => `${name.replace('_', ' ')} ${check.status}: ${check.instruction}`),
    `${checks.filter(([, check]) => check.status === 'pass').length} of ${checks.length} checks passed.`,
  ];
}
function completedReceipt(operation: Operation, data: unknown): Omit<Receipt, 'tone'> {
  const { command } = operation;
  switch (command.kind) {
    case 'setup':
      return {
        headline: 'Setup complete. Core remains stopped.',
        lines: [`API key ID ${command.credential.api_key_id}`],
      };
    case 'provision':
      return {
        headline: 'Credential added.',
        lines: [`API key ID ${command.credential.api_key_id}`],
      };
    case 'start':
      return { headline: 'Start completed.', lines: [] };
    case 'restart':
      return { headline: 'Restart completed.', lines: [] };
    case 'stop':
      return {
        headline: z.object({ writer_exit: z.literal('verified') }).safeParse(data).success
          ? 'Stopped. Writer exit verified.'
          : 'Stop returned without writer exit evidence.',
        lines: [],
      };
    case 'settings-save': {
      const saved = SettingsView.safeParse(data);
      return {
        headline: 'Settings saved. Not active until restart.',
        lines: saved.success
          ? [`Saved revision ${saved.data.revision}.`]
          : ['Saved revision unavailable.'],
      };
    }
    case 'tls-replace': {
      const tls = TlsView.safeParse(data);
      return {
        headline: 'Certificate saved. Not active until restart.',
        lines: tls.success ? certificateLines(tls.data) : ['Certificate state unavailable.'],
      };
    }
    case 'export': {
      const exported = Export.safeParse(data);
      if (!exported.success)
        return { headline: 'Export finished. Size and completeness unavailable.', lines: [] };
      return {
        headline: exported.data.partial
          ? `Partial export, ${exported.data.bytes} bytes. Some diagnostics are missing.`
          : `Exported ${exported.data.bytes} bytes.`,
        lines: [command.out],
      };
    }
    case 'doctor':
      return { headline: 'Installation check passed.', lines: doctorLines(data) };
    default:
      return { headline: 'Operation completed.', lines: [] };
  }
}
const guidance = (root: string): Record<string, string> => ({
  recovery_required: `Run: ${recoverCommand(root)}`,
  repair_required: 'Preserve this installation for repair. Do not rerun setup.',
  already_setup: 'Existing or partial setup. Preserve it and select a fresh installation path.',
  management_busy: 'Another command holds this installation. Wait, then refresh status.',
  settings_revision_changed: 'Saved settings changed elsewhere. Review them and edit again.',
  tls_generation_limit: `Certificate history is full. Stop Core, then run: ${recoverCommand(root)}`,
  writer_exit_unverified: `Writer exit is unverified. Inspect status. CLI: ${stopCommand(root)}`,
  maintenance_unavailable: `Core did not answer. Inspect status. CLI: ${stopCommand(root)}`,
});
function failureLines(root: string, result: CommandResult): string[] {
  const parsed = Envelope.safeParse(result.envelope);
  if (!parsed.success) return ['Failure detail unavailable.'];
  const { code, primary_failure, cleanup_failure, failures, data } = parsed.data;
  const codes = [code, primary_failure, cleanup_failure, ...(failures ?? [])];
  const advice = guidance(root);
  return [
    code ? `Code ${code}` : 'Failure code unavailable.',
    ...(primary_failure ? [`Primary failure ${primary_failure}`] : []),
    ...(cleanup_failure ? [`Cleanup failure ${cleanup_failure}`] : []),
    ...(failures?.length ? [`Failures ${failures.join(', ')}`] : []),
    ...(data === undefined ? [] : doctorLines(data)),
    ...new Set(codes.flatMap((item) => (item && advice[item] ? [advice[item]] : []))),
  ];
}
const uncertainIdentity = (operation: Operation) =>
  operation.command.kind === 'setup' || operation.command.kind === 'provision'
    ? [`API key ID ${operation.command.credential.api_key_id}, if it was created.`]
    : [];
export function summarize(root: string, operation: Operation, result: CommandResult): Receipt {
  const data = Envelope.safeParse(result.envelope).data?.data;
  if (result.exitCode === 1) {
    const write = operation.effect === 'write';
    return {
      tone: 'error',
      headline: write
        ? 'Operation failed. Committed effects may remain. Inspect status before retrying.'
        : 'Installation check failed.',
      lines: [...failureLines(root, result), ...uncertainIdentity(operation)],
    };
  }
  if (result.exitCode === 0) return { tone: 'success', ...completedReceipt(operation, data) };
  if (Cancelled.safeParse(data).success)
    return { tone: 'warning', headline: 'Cancelled before any change.', lines: [] };
  const { headline, lines } = completedReceipt(operation, data);
  return {
    tone: 'warning',
    headline: `Cancellation arrived after the operation finished. ${headline}`,
    lines: [...lines, 'Inspect status before retrying.'],
  };
}
