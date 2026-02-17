import { Box, Text, useApp, useInput } from 'ink';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { parseArgs } from './args';
import { runCreateDemo } from './commands/create';
import { runMigrateStatus, runMigrateUp } from './commands/migrate';
import { CLI_VERSION } from './constants';
import { CreateLibrariesWizardApp } from './create-libraries-wizard';
import { formatDoctorResult } from './doctor';
import type { CommandResult, MenuItem, RootCommand } from './types';

export function InteractiveApp(props: {
  initialCommand: RootCommand | null;
}): ReactElement {
  const { exit } = useApp();
  const [screen, setScreen] = useState<'menu' | 'create'>(() =>
    props.initialCommand === 'create' ? 'create' : 'menu'
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [result, setResult] = useState<CommandResult | null>(null);
  const [running, setRunning] = useState(false);
  const [createArgs] = useState(() => parseArgs(['create']));

  const menuItems = useMemo((): MenuItem[] => {
    if (props.initialCommand === 'migrate') {
      return [
        {
          id: 'migrate-status',
          label: 'migrate status',
          description: 'Run adapter status()',
        },
        {
          id: 'migrate-up',
          label: 'migrate up',
          description: 'Run adapter up()',
        },
        {
          id: 'migrate-reset-mode',
          label: 'migrate up (reset mode)',
          description: 'Runs reset mode with confirmation',
        },
        {
          id: 'help',
          label: 'help',
          description: 'Show command overview',
        },
        {
          id: 'quit',
          label: 'quit',
          description: 'Exit the CLI',
        },
      ];
    }

    return [
      {
        id: 'doctor',
        label: 'doctor',
        description: 'Run local environment checks',
      },
      {
        id: 'create',
        label: 'create',
        description: 'Open interactive libraries scaffold wizard',
      },
      {
        id: 'create-demo',
        label: 'create demo',
        description: 'Generate runnable demo scaffold',
      },
      {
        id: 'migrate-status',
        label: 'migrate status',
        description: 'Run adapter status()',
      },
      {
        id: 'migrate-up',
        label: 'migrate up',
        description: 'Run adapter up()',
      },
      {
        id: 'help',
        label: 'help',
        description: 'Show command overview',
      },
      {
        id: 'quit',
        label: 'quit',
        description: 'Exit the CLI',
      },
    ];
  }, [props.initialCommand]);

  useInput((input, key) => {
    if (screen === 'create') return;
    if (running) return;

    if (input.toLowerCase() === 'q') {
      exit();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((index) =>
        index === 0 ? menuItems.length - 1 : index - 1
      );
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((index) =>
        index === menuItems.length - 1 ? 0 : index + 1
      );
      return;
    }

    if (key.return) {
      const selected = menuItems[selectedIndex];
      if (!selected) return;

      if (selected.id === 'quit') {
        exit();
        return;
      }

      if (selected.id === 'create') {
        setScreen('create');
        return;
      }

      setRunning(true);
      void runInteractiveAction(selected)
        .then((nextResult) => {
          setResult(nextResult);
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          setResult({
            title: 'Error',
            ok: false,
            lines: [message],
          });
        })
        .finally(() => {
          setRunning(false);
        });
    }
  });

  return (
    <>
      {screen === 'create' ? (
        <CreateLibrariesWizardApp
          args={createArgs}
          onClose={(wizardResult) => {
            if (wizardResult) {
              setResult(wizardResult);
            }
            setScreen('menu');
          }}
        />
      ) : (
        <Box flexDirection="column">
          <Text>syncular CLI v{CLI_VERSION}</Text>
          <Text color="gray">
            Use up/down arrows to navigate, Enter to run, q to exit.
          </Text>
          <Box marginTop={1} flexDirection="column">
            {menuItems.map((item, index) => {
              const active = index === selectedIndex;
              return (
                <Text key={item.id} color={active ? 'cyan' : undefined}>
                  {active ? '>' : ' '} {item.label.padEnd(24)}{' '}
                  {item.description}
                </Text>
              );
            })}
          </Box>
          {running ? (
            <Box marginTop={1}>
              <Text color="yellow">Running...</Text>
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
      )}
    </>
  );
}

async function runInteractiveAction(item: MenuItem): Promise<CommandResult> {
  switch (item.id) {
    case 'doctor':
      return formatDoctorResult(process.cwd());
    case 'create':
      throw new Error('Create should be handled before runInteractiveAction.');
    case 'create-demo':
      return runCreateDemo(parseArgs(['create', 'demo']));
    case 'migrate-status':
      return runMigrateStatus(parseArgs(['migrate', 'status']));
    case 'migrate-up':
      return runMigrateUp(parseArgs(['migrate', 'up']));
    case 'migrate-reset-mode':
      return runMigrateUp(
        parseArgs(['migrate', 'up', '--on-checksum-mismatch', 'reset', '--yes'])
      );
    case 'help':
      return {
        title: 'Help',
        ok: true,
        lines: [
          'Create libraries (interactive):',
          'syncular create',
          'Create runnable demo:',
          'syncular create demo --dir ./my-syncular-demo',
          'Migrate commands use the adapter from syncular.config.json.',
        ],
      };
    case 'quit':
      return {
        title: 'Quit',
        ok: true,
        lines: ['Goodbye.'],
      };
  }
}
