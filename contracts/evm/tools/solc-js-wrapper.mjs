#!/usr/bin/env node
// Drop-in `solc` CLI for Foundry backed by the npm `solc` (solc-js / emscripten) build.
//
// Use it when binaries.soliditylang.org is unreachable (locked-down CI, sandboxes):
//   FOUNDRY_SOLC=contracts/evm/tools/solc-js-wrapper.mjs forge test
// or set `solc = "tools/solc-js-wrapper.mjs"` in foundry.toml. Forge only ever calls
// `solc --version` and `solc --standard-json [path flags]`; both are emulated here.
// Compilation is slower than the native binary (~10x) but produces identical bytecode.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const solc = require('solc');

const args = process.argv.slice(2);
if (args.includes('--version')) {
  const v = solc.version(); // e.g. 0.8.28+commit.7893614a.Emscripten.clang
  process.stdout.write(`solc, the solidity compiler commandline interface\nVersion: ${v}\n`);
  process.exit(0);
}
if (!args.includes('--standard-json')) {
  process.stderr.write(`solc-js-wrapper: unsupported arguments ${args.join(' ')}\n`);
  process.exit(1);
}
const input = readFileSync(0, 'utf8');
// Forge inlines every source's content, so import resolution never has to hit disk.
// A callback is still provided so a stray relative import gives a clear error.
const out = solc.compile(input, {
  import: (path) => ({ error: `solc-js-wrapper: unresolved import ${path} (forge should have inlined it)` }),
});
process.stdout.write(out);
