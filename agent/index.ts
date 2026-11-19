#!/usr/bin/env node
/**
 * tnyc-agent-kvm host agent. Uploaded to the host and run as
 *   node <dir>/agent.cjs rpc
 *   node <dir>/agent.cjs pty --cols N --rows M [--session NAME]
 *   node <dir>/agent.cjs pipe --port N
 */
import { runPipe } from './modes/pipe';
import { runPty } from './modes/pty';
import { runRpc } from './modes/rpc';
import { AGENT_VERSION } from './lib/util';

const USAGE = `usage:
  agent.cjs rpc
  agent.cjs pty --cols N --rows M [--session NAME]
  agent.cjs pipe --port N
  agent.cjs version
`;

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function numberFlag(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

async function main(argv: string[]): Promise<void> {
  const mode = argv[0];
  switch (mode) {
    case 'rpc':
      return runRpc();
    case 'pty':
      return runPty({
        cols: numberFlag(flag(argv, '--cols'), 80),
        rows: numberFlag(flag(argv, '--rows'), 24),
        session: flag(argv, '--session'),
      });
    case 'pipe': {
      const port = Number(flag(argv, '--port'));
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error('pipe requires --port N');
      }
      return runPipe(port);
    }
    case 'version':
    case '--version':
      process.stdout.write(`${AGENT_VERSION}\n`);
      return;
    default:
      process.stderr.write(USAGE);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  process.stderr.write(`agent: ${err.message}\n`);
  process.exitCode = 1;
});
