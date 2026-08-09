import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const instagramRoot = new URL('../src/instagram/', import.meta.url);

function sourceFiles(directory: URL): URL[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = new URL(entry.name, directory);
    return entry.isDirectory() ? sourceFiles(new URL(`${entry.name}/`, directory)) : [target];
  }).filter((file) => file.pathname.endsWith('.ts'));
}

describe('Instagram core import isolation', () => {
  it('does not depend on OpenClaw glue or SDK packages', () => {
    const violations = sourceFiles(instagramRoot).flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return /(?:from\s+|import\s*\()["'](?:openclaw\/|[^"']*\/openclaw\/)/g.test(source)
        ? [path.basename(file.pathname)]
        : [];
    });
    expect(violations).toEqual([]);
  });
});
