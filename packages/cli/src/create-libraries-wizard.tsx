import process from 'node:process';
import { Box, Text, useApp, useInput } from 'ink';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import {
  resolveLibrariesOptions,
  runCreateLibrariesWithOptions,
} from './commands/create';
import {
  CLIENT_DIALECT_TEMPLATES,
  DEFAULT_LIBRARIES_TARGETS,
  ELECTRON_DIALECT_TEMPLATES,
  LIBRARIES_TARGETS,
} from './constants';
import type {
  ClientDialect,
  CommandResult,
  ElectronDialect,
  LibrariesOptions,
  LibrariesTarget,
  ParsedArgs,
  ServerDialect,
} from './types';

type WizardStep =
  | 'targets'
  | 'react-dialect'
  | 'vanilla-dialect'
  | 'electron-dialect'
  | 'server-dialect'
  | 'confirm'
  | 'result';

type ConfirmAction = 'generate-default' | 'generate-alt' | 'cancel';

interface Choice<TValue extends string> {
  value: TValue;
  label: string;
  description: string;
}

interface CreateLibrariesWizardProps {
  args: ParsedArgs;
  onClose?: (result: CommandResult | null) => void;
}

const TARGET_METADATA: Record<
  LibrariesTarget,
  { label: string; description: string }
> = {
  server: {
    label: 'server',
    description: 'Server module scaffold',
  },
  react: {
    label: 'react',
    description: 'React client bindings + setup',
  },
  vanilla: {
    label: 'vanilla',
    description: 'Framework-free client setup',
  },
  expo: {
    label: 'expo',
    description: 'Expo SQLite client setup',
  },
  'react-native': {
    label: 'react-native',
    description: 'React Native Nitro SQLite setup',
  },
  electron: {
    label: 'electron',
    description: 'Electron client setup',
  },
  'proxy-api': {
    label: 'proxy-api',
    description: 'Admin proxy API setup',
  },
};

const SERVER_DIALECT_CHOICES: Choice<ServerDialect>[] = [
  {
    value: 'sqlite',
    label: 'sqlite',
    description: 'Bun SQLite server dialect',
  },
  {
    value: 'postgres',
    label: 'postgres',
    description: 'Postgres server dialect',
  },
];

const CLIENT_DIALECT_CHOICES: Choice<ClientDialect>[] = [
  {
    value: 'wa-sqlite',
    label: 'wa-sqlite',
    description: CLIENT_DIALECT_TEMPLATES['wa-sqlite'].label,
  },
  {
    value: 'pglite',
    label: 'pglite',
    description: CLIENT_DIALECT_TEMPLATES.pglite.label,
  },
  {
    value: 'bun-sqlite',
    label: 'bun-sqlite',
    description: CLIENT_DIALECT_TEMPLATES['bun-sqlite'].label,
  },
  {
    value: 'better-sqlite3',
    label: 'better-sqlite3',
    description: CLIENT_DIALECT_TEMPLATES['better-sqlite3'].label,
  },
  {
    value: 'sqlite3',
    label: 'sqlite3',
    description: CLIENT_DIALECT_TEMPLATES.sqlite3.label,
  },
];

const ELECTRON_DIALECT_CHOICES: Choice<ElectronDialect>[] = [
  {
    value: 'electron-sqlite',
    label: 'electron-sqlite',
    description: ELECTRON_DIALECT_TEMPLATES['electron-sqlite'].label,
  },
  {
    value: 'better-sqlite3',
    label: 'better-sqlite3',
    description: ELECTRON_DIALECT_TEMPLATES['better-sqlite3'].label,
  },
];

function getDialectSteps(targets: Set<LibrariesTarget>): WizardStep[] {
  const steps: WizardStep[] = [];
  if (targets.has('react')) steps.push('react-dialect');
  if (targets.has('vanilla')) steps.push('vanilla-dialect');
  if (targets.has('electron')) steps.push('electron-dialect');
  if (targets.has('server')) steps.push('server-dialect');
  return steps;
}

function nextStep(
  current: WizardStep,
  targets: Set<LibrariesTarget>
): WizardStep {
  const dialectSteps = getDialectSteps(targets);
  if (current === 'targets') return dialectSteps[0] ?? 'confirm';

  const dialectIndex = dialectSteps.indexOf(current);
  if (dialectIndex >= 0) {
    return dialectSteps[dialectIndex + 1] ?? 'confirm';
  }

  if (current === 'confirm') return 'result';
  return current;
}

function previousStep(
  current: WizardStep,
  targets: Set<LibrariesTarget>
): WizardStep {
  const dialectSteps = getDialectSteps(targets);
  if (current === 'confirm') {
    const lastDialect = dialectSteps[dialectSteps.length - 1];
    return lastDialect ?? 'targets';
  }

  const dialectIndex = dialectSteps.indexOf(current);
  if (dialectIndex >= 0) {
    return dialectIndex === 0 ? 'targets' : dialectSteps[dialectIndex - 1]!;
  }

  return current;
}

function getStepChoices(args: {
  step: WizardStep;
  targetDir: string;
  defaultForce: boolean;
  targets: Set<LibrariesTarget>;
}): Choice<
  | LibrariesTarget
  | 'continue'
  | ClientDialect
  | ElectronDialect
  | ServerDialect
  | ConfirmAction
>[] {
  if (args.step === 'targets') {
    const targetChoices = LIBRARIES_TARGETS.map((target) => ({
      value: target,
      label: TARGET_METADATA[target].label,
      description: TARGET_METADATA[target].description,
    }));

    return [
      ...targetChoices,
      {
        value: 'continue',
        label: 'Continue',
        description: 'Proceed with selected targets',
      },
    ];
  }

  if (args.step === 'react-dialect' || args.step === 'vanilla-dialect') {
    return CLIENT_DIALECT_CHOICES;
  }

  if (args.step === 'electron-dialect') {
    return ELECTRON_DIALECT_CHOICES;
  }

  if (args.step === 'server-dialect') {
    return SERVER_DIALECT_CHOICES;
  }

  if (args.step === 'confirm') {
    return [
      {
        value: 'generate-default',
        label: args.defaultForce
          ? `Generate (force) in ${args.targetDir}`
          : `Generate in ${args.targetDir}`,
        description: args.defaultForce
          ? 'Overwrite generated files when needed'
          : 'Keep existing files and create missing ones',
      },
      {
        value: 'generate-alt',
        label: args.defaultForce
          ? 'Generate without force'
          : 'Generate with --force',
        description: args.defaultForce
          ? 'Keep existing files and create missing ones'
          : 'Overwrite generated files when needed',
      },
      {
        value: 'cancel',
        label: 'Cancel',
        description: 'Exit without generating files',
      },
    ];
  }

  return [];
}

function getStepLabel(step: WizardStep): string {
  if (step === 'targets') return 'Step 1: select library targets';
  if (step === 'react-dialect') return 'Step 2: choose React dialect';
  if (step === 'vanilla-dialect') return 'Step 2: choose Vanilla dialect';
  if (step === 'electron-dialect') return 'Step 2: choose Electron dialect';
  if (step === 'server-dialect') return 'Step 2: choose Server dialect';
  if (step === 'confirm') return 'Step 3: confirm';
  return 'Done';
}

function toLibrariesOptions(args: {
  targetDir: string;
  force: boolean;
  targets: Set<LibrariesTarget>;
  reactDialect: ClientDialect;
  vanillaDialect: ClientDialect;
  electronDialect: ElectronDialect;
  serverDialect: ServerDialect;
}): LibrariesOptions {
  return {
    targetDir: args.targetDir,
    force: args.force,
    targets: LIBRARIES_TARGETS.filter((target) => args.targets.has(target)),
    reactDialect: args.reactDialect,
    vanillaDialect: args.vanillaDialect,
    electronDialect: args.electronDialect,
    serverDialect: args.serverDialect,
  };
}

export function CreateLibrariesWizardApp(
  props: CreateLibrariesWizardProps
): ReactElement {
  const { exit } = useApp();
  const resolvedDefaults = useMemo(
    () => resolveLibrariesOptions(props.args),
    [props.args]
  );

  const [selectedTargets, setSelectedTargets] = useState<Set<LibrariesTarget>>(
    () => {
      if ('error' in resolvedDefaults) {
        return new Set(DEFAULT_LIBRARIES_TARGETS);
      }
      return new Set(resolvedDefaults.targets);
    }
  );
  const [reactDialect, setReactDialect] = useState<ClientDialect>(() => {
    if ('error' in resolvedDefaults) return 'wa-sqlite';
    return resolvedDefaults.reactDialect;
  });
  const [vanillaDialect, setVanillaDialect] = useState<ClientDialect>(() => {
    if ('error' in resolvedDefaults) return 'wa-sqlite';
    return resolvedDefaults.vanillaDialect;
  });
  const [electronDialect, setElectronDialect] = useState<ElectronDialect>(
    () => {
      if ('error' in resolvedDefaults) return 'electron-sqlite';
      return resolvedDefaults.electronDialect;
    }
  );
  const [serverDialect, setServerDialect] = useState<ServerDialect>(() => {
    if ('error' in resolvedDefaults) return 'sqlite';
    return resolvedDefaults.serverDialect;
  });
  const [targetDir] = useState(() => {
    if ('error' in resolvedDefaults) return process.cwd();
    return resolvedDefaults.targetDir;
  });
  const [defaultForce] = useState(() => {
    if ('error' in resolvedDefaults) return false;
    return resolvedDefaults.force;
  });
  const [step, setStep] = useState<WizardStep>(() => {
    if ('error' in resolvedDefaults) return 'result';
    return 'targets';
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [result, setResult] = useState<CommandResult | null>(() => {
    if ('error' in resolvedDefaults) {
      return {
        title: 'Create Libraries',
        ok: false,
        lines: [resolvedDefaults.error],
      };
    }
    return null;
  });

  const choices = useMemo(
    () =>
      getStepChoices({
        step,
        targetDir,
        defaultForce,
        targets: selectedTargets,
      }),
    [step, targetDir, defaultForce, selectedTargets]
  );

  const closeWizard = (nextResult: CommandResult | null): void => {
    if (props.onClose) {
      props.onClose(nextResult);
      return;
    }
    exit();
  };

  useInput((input, key) => {
    if (running) return;

    if (input.toLowerCase() === 'q') {
      closeWizard(result);
      return;
    }

    if (step === 'result') {
      if (key.return) closeWizard(result);
      return;
    }

    if (input.toLowerCase() === 'b' && step !== 'targets') {
      setStep(previousStep(step, selectedTargets));
      setSelectedIndex(0);
      setHint(null);
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((index) =>
        index === 0 ? choices.length - 1 : index - 1
      );
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((index) =>
        index === choices.length - 1 ? 0 : index + 1
      );
      return;
    }

    const selected = choices[selectedIndex];
    if (!selected) return;

    if (step === 'targets' && input === ' ') {
      if (selected.value === 'continue') return;
      const target = selected.value as LibrariesTarget;
      const nextTargets = new Set(selectedTargets);
      if (nextTargets.has(target)) {
        nextTargets.delete(target);
      } else {
        nextTargets.add(target);
      }
      setSelectedTargets(nextTargets);
      setHint(null);
      return;
    }

    if (!key.return) return;

    if (step === 'targets') {
      if (selected.value === 'continue') {
        if (selectedTargets.size === 0) {
          setHint('Select at least one target before continuing.');
          return;
        }
        setStep(nextStep(step, selectedTargets));
        setSelectedIndex(0);
        setHint(null);
        return;
      }

      const nextTargets = new Set(selectedTargets);
      const target = selected.value as LibrariesTarget;
      if (nextTargets.has(target)) {
        nextTargets.delete(target);
      } else {
        nextTargets.add(target);
      }
      setSelectedTargets(nextTargets);
      setHint(null);
      return;
    }

    if (step === 'react-dialect') {
      setReactDialect(selected.value as ClientDialect);
      setStep(nextStep(step, selectedTargets));
      setSelectedIndex(0);
      return;
    }

    if (step === 'vanilla-dialect') {
      setVanillaDialect(selected.value as ClientDialect);
      setStep(nextStep(step, selectedTargets));
      setSelectedIndex(0);
      return;
    }

    if (step === 'electron-dialect') {
      setElectronDialect(selected.value as ElectronDialect);
      setStep(nextStep(step, selectedTargets));
      setSelectedIndex(0);
      return;
    }

    if (step === 'server-dialect') {
      setServerDialect(selected.value as ServerDialect);
      setStep(nextStep(step, selectedTargets));
      setSelectedIndex(0);
      return;
    }

    if (step === 'confirm') {
      const action = selected.value as ConfirmAction;
      if (action === 'cancel') {
        closeWizard(null);
        return;
      }

      const force =
        action === 'generate-default' ? defaultForce : !defaultForce;

      setRunning(true);
      void runCreateLibrariesWithOptions(
        toLibrariesOptions({
          targetDir,
          force,
          targets: selectedTargets,
          reactDialect,
          vanillaDialect,
          electronDialect,
          serverDialect,
        })
      )
        .then((nextResult) => {
          if (props.onClose) {
            closeWizard(nextResult);
            return;
          }
          setResult(nextResult);
          setStep('result');
          setSelectedIndex(0);
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          const failedResult: CommandResult = {
            title: 'Create Libraries',
            ok: false,
            lines: [message],
          };
          if (props.onClose) {
            closeWizard(failedResult);
            return;
          }
          setResult(failedResult);
          setStep('result');
          setSelectedIndex(0);
        })
        .finally(() => {
          setRunning(false);
        });
    }
  });

  return (
    <Box flexDirection="column">
      <Text>syncular create (libraries)</Text>
      <Text color="gray">
        {step === 'result'
          ? 'Press Enter or q to exit.'
          : 'Use up/down + Enter, space to toggle targets, b to go back, q to quit.'}
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text>{getStepLabel(step)}</Text>
        <Text color="gray">
          targets:{' '}
          {LIBRARIES_TARGETS.filter((target) =>
            selectedTargets.has(target)
          ).join(', ') || '(none)'}
        </Text>
        <Text color="gray">react dialect: {reactDialect}</Text>
        <Text color="gray">vanilla dialect: {vanillaDialect}</Text>
        <Text color="gray">electron dialect: {electronDialect}</Text>
        <Text color="gray">server dialect: {serverDialect}</Text>
        <Text color="gray">target dir: {targetDir}</Text>
      </Box>

      {hint ? (
        <Box marginTop={1}>
          <Text color="yellow">{hint}</Text>
        </Box>
      ) : null}

      {step !== 'result' ? (
        <Box marginTop={1} flexDirection="column">
          {choices.map((choice, index) => {
            const active = index === selectedIndex;
            const checked =
              step === 'targets' && choice.value !== 'continue'
                ? selectedTargets.has(choice.value as LibrariesTarget)
                : false;
            const marker =
              step === 'targets' ? (checked ? '[x]' : '[ ]') : ' - ';

            return (
              <Text
                key={`${step}:${choice.value}`}
                color={active ? 'cyan' : undefined}
              >
                {active ? '>' : ' '} {marker} {choice.label.padEnd(20)}{' '}
                {choice.description}
              </Text>
            );
          })}
        </Box>
      ) : null}

      {running ? (
        <Box marginTop={1}>
          <Text color="yellow">Generating libraries scaffold...</Text>
        </Box>
      ) : null}

      {result ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={result.ok ? 'green' : 'red'}>{result.title}</Text>
          {result.lines.map((line) => (
            <Text key={line}> {line}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
