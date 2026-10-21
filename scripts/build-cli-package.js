#!/usr/bin/env node
/**
 * Build the publishable CLI package.
 *
 * The CLI is compiled with the rest of the platform into `dist/cli`. This
 * copies that bundle into `packages/cli/bin/viventure.js` and makes it
 * executable, so the published package carries the same code that the
 * repository builds — there is no second source of truth.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'dist', 'cli', 'index.js');
const targetDir = path.join(root, 'packages', 'cli', 'bin');
const target = path.join(targetDir, 'viventure.js');

if (!fs.existsSync(source)) {
  console.error(`error: ${source} does not exist — run the main build first`);
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);
fs.chmodSync(target, 0o755);

// The published package carries the platform's version, so the two never
// drift apart.
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const cliPkgPath = path.join(root, 'packages', 'cli', 'package.json');
const cliPkg = JSON.parse(fs.readFileSync(cliPkgPath, 'utf8'));
cliPkg.version = rootPkg.version;
// The CLI's runtime dependency is the one the bundle leaves external.
cliPkg.dependencies = { commander: rootPkg.dependencies?.commander ?? '^14.0.1' };
fs.writeFileSync(cliPkgPath, `${JSON.stringify(cliPkg, null, 2)}\n`);

const size = fs.statSync(target).size;
console.log(`CLI package built: packages/cli/bin/viventure.js (${Math.round(size / 1024)} kB), version ${rootPkg.version}`);
