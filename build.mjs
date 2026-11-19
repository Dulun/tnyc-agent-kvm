import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const out = 'build';

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  {
    entryPoints: ['src/main/index.ts'],
    outfile: `${out}/main/index.cjs`,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    bundle: true,
    sourcemap: true,
    external: ['electron', 'ssh2'],
    logLevel: 'info',
  },
  {
    entryPoints: ['src/preload/index.ts'],
    outfile: `${out}/preload/index.cjs`,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    bundle: true,
    sourcemap: true,
    external: ['electron'],
    logLevel: 'info',
  },
  {
    entryPoints: ['src/renderer/main.ts'],
    outfile: `${out}/renderer/main.js`,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    bundle: true,
    sourcemap: true,
    loader: { '.css': 'css', '.svg': 'dataurl', '.png': 'dataurl' },
    logLevel: 'info',
  },
  {
    // single-file host agent, uploaded to the Ubuntu host over SFTP
    entryPoints: ['agent/index.ts'],
    outfile: `${out}/agent/agent.cjs`,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    bundle: true,
    sourcemap: false,
    logLevel: 'info',
  },
];

async function copyStatic() {
  await mkdir(`${out}/renderer`, { recursive: true });
  await cp('src/renderer/index.html', `${out}/renderer/index.html`);
  if (existsSync('src/renderer/style.css')) {
    await cp('src/renderer/style.css', `${out}/renderer/style.css`);
  }
  await mkdir(`${out}/assets`, { recursive: true });
  await cp('assets', `${out}/assets`, { recursive: true });
  await cp('assets/guest/bootstrap.sh', `${out}/agent/bootstrap.sh`);
  // agent ships next to the bundle for the SFTP upload step
  await mkdir(`${out}/agent`, { recursive: true });
  await cp('agent/package.json', `${out}/agent/package.json`);
}

await rm(out, { recursive: true, force: true });
await copyStatic();

if (watch) {
  for (const t of targets) {
    const ctx = await context(t);
    await ctx.watch();
  }
  console.log('watching…');
} else {
  await Promise.all(targets.map((t) => build(t)));
  await copyStatic();
  console.log('build ok');
}
