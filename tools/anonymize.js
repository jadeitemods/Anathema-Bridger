'use strict';

// Copies this project into a cleaned, renamed tree for publishing, e.g.
//   node tools/anonymize.js ../ChatBridger-Public --brand Anathema
//
// - renames files and folders that carry the old brand
// - rewrites brand text inside source, config samples and docs
// - drops credentials, E2EE keys, logs and build output
// - strips this deployment's host names, addresses and ids

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const target = args[0];
const brandIndex = args.indexOf('--brand');
const newBrand = brandIndex >= 0 ? args[brandIndex + 1] : 'Anathema';

if (!target) {
  console.error('usage: node tools/anonymize.js <targetDir> [--brand Anathema]');
  process.exit(1);
}

const sourceRoot = path.resolve(__dirname, '..');
const targetRoot = path.resolve(target);

const SKIP_DIRS = new Set([
  'node_modules', 'bin', 'obj', 'build', '.gradle', '.git', 'logs', '.valour-e2ee', '.vscode',
]);

const SKIP_FILES = new Set([
  'config.json',
  'global-commands-backup.json',
  'watchdog.log',
]);

const TEXT_EXTENSIONS = new Set([
  '.js', '.json', '.cs', '.csproj', '.java', '.gradle', '.properties', '.md', '.cmd', '.ps1',
  '.txt', '.gitignore', '.mod', '.yml', '.yaml',
]);

// Text files that carry no extension.
const TEXT_NAMES = new Set(['LICENSE', 'gradlew', '.gitignore']);

// Longest first: otherwise "Anathema" would be half-substituted by "Anathema".
const REPLACEMENTS = [
  ['Anathema', newBrand],
  ['Anathema', newBrand],
  ['AnathemaBridge', `${newBrand}Bridge`],
  ['AnathemaValour', `${newBrand}Valour`],
  ['ANATHEMA', newBrand.toUpperCase()],
  ['anathema-bridge', `${newBrand.toLowerCase()}-bridge`],
  ['anathema', newBrand.toLowerCase()],
  ['Anathema', newBrand],
  // Deployment specifics from this machine.
  ['bridge.example.com', 'bridge.example.com'],
  ['server.example.com:25565', 'server.example.com:25565'],
  ['00000000', '00000000'],
];

function rename(value) {
  return REPLACEMENTS.reduce((result, [from, to]) => result.split(from).join(to), value);
}

function scrub(text) {
  return rename(text);
}

/** Blanks credential-shaped values; only applied to the sample config. */
function scrubSecrets(text) {
  return text.replace(/"(botToken|apiKey|secret|artifactToken)"\s*:\s*"[^"]+"/g, '"$1": ""');
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const renamed = rename(entry.name);
    const destination = path.join(to, renamed);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      copyTree(source, destination);
      continue;
    }

    if (SKIP_FILES.has(entry.name)) continue;

    const extension = path.extname(entry.name).toLowerCase();
    const isText = TEXT_EXTENSIONS.has(extension) || TEXT_NAMES.has(entry.name);

    if (isText) {
      fs.writeFileSync(destination, scrub(fs.readFileSync(source, 'utf8')), 'utf8');
    } else {
      fs.copyFileSync(source, destination);
    }
  }
}

const outputDir = path.join(targetRoot, `${newBrand}Bridger`);

copyTree(sourceRoot, outputDir);

// A sample config is useful; the real one is deliberately absent.
const example = fs.readFileSync(path.join(sourceRoot, 'config.example.json'), 'utf8');
fs.writeFileSync(path.join(outputDir, 'config.example.json'), scrubSecrets(scrub(example)), 'utf8');

console.log(`anonymised copy written to ${outputDir}`);
console.log(`brand: ${newBrand}`);
