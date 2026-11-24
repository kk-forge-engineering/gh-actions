// Cuts a step's `run:` block out of a workflow, so a test runs the script GitHub runs, not a copy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** The `run: |` block of the step named `name` in `.github/workflows/<workflow>`, without its indent. */
export const stepScript = (workflow: string, name: string): string => {
  const lines = readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `${workflow} has no step "${name}"`);
  const run = lines.findIndex((line, i) => i > start && line.trim() === 'run: |');
  const indent = (line: string): number => line.length - line.trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && indent(line) <= indent(lines[run])) break;
    body.push(line);
  }
  const margin = indent(body[0]);
  const script = body.map((line) => line.slice(margin)).join('\n');
  // An expression would reach the script only through GitHub, so the test would run something else.
  assert.doesNotMatch(script, /\$\{\{/, `the step "${name}" puts an expression into its script`);
  return script;
};
