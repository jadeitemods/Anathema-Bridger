'use strict';

// Re-indents config.json into the hand-aligned style used throughout this project:
// values line up in a column per section, and sections are separated by a blank line.
// Run after any programmatic edit so the file stays readable for non-technical editors.
//
//   node tools/format-config.js [path]     (defaults to config.json at the repo root)

const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'config.json');

const data = JSON.parse(fs.readFileSync(target, 'utf8'));

function flatten(value) {
  return JSON.stringify(value);
}

/** String lists are easier to edit one-per-line. */
function formatValue(value, indent) {
  if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')) {
    const items = value.map(item => `${indent}  ${JSON.stringify(item)}`);
    return `[\n${items.join(',\n')}\n${indent}]`;
  }

  return flatten(value);
}

function formatSection(name, object) {
  const keys = Object.keys(object);
  const width = Math.max(...keys.map(key => `"${key}":`.length));
  const lines = keys.map(key => {
    const label = `"${key}":`.padEnd(width + 1, ' ');
    return `    ${label}${formatValue(object[key], '    ')}`;
  });

  return `  "${name}": {\n${lines.join(',\n')}\n  }`;
}

const sections = Object.keys(data).map(name => {
  const value = data[name];
  const isSection = value && typeof value === 'object' && !Array.isArray(value);
  return isSection ? formatSection(name, value) : `  "${name}": ${flatten(value)}`;
});

fs.writeFileSync(target, `{\n${sections.join(',\n\n')}\n}\n`, 'utf8');
console.log(`formatted ${target}`);
