import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findCoveringBackup } from './db_maintenance';

let dir: string;

function writeManifest(name: string, newestMessage: string | null, createdAt: string): void {
  fs.writeFileSync(
    path.join(dir, `${name}.manifest.json`),
    JSON.stringify({ createdAt, file: `${name}.jsonl.gz`, messageCount: 10, newestMessage })
  );
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

describe('findCoveringBackup', () => {
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tldr-guard-'));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('refuses when the directory does not exist', () => {
    assert.match(String(findCoveringBackup(path.join(dir, 'missing'), 48)), /no backup directory/);
  });

  test('refuses when the directory holds no manifests', () => {
    assert.match(String(findCoveringBackup(dir, 48)), /no backup manifests/);
  });

  test('refuses when the newest backup predates the deletion cutoff', () => {
    // Purge deletes everything older than 48h, but the backup stops at 72h ago:
    // the 72h..48h window would be deleted with no copy anywhere.
    writeManifest('stale', hoursAgo(72), hoursAgo(72));
    assert.match(String(findCoveringBackup(dir, 48)), /only covers up to/);
  });

  test('allows when a backup reaches past the cutoff', () => {
    writeManifest('fresh', hoursAgo(1), hoursAgo(1));
    assert.equal(findCoveringBackup(dir, 48), null);
  });

  test('refuses when the newest manifest records no coverage', () => {
    fs.rmSync(path.join(dir, 'fresh.manifest.json'));
    fs.rmSync(path.join(dir, 'stale.manifest.json'));
    writeManifest('empty', null, hoursAgo(1));
    assert.match(String(findCoveringBackup(dir, 48)), /does not record/);
  });

  test('ignores unreadable manifests instead of crashing', () => {
    fs.writeFileSync(path.join(dir, 'broken.manifest.json'), '{not json');
    assert.doesNotThrow(() => findCoveringBackup(dir, 48));
  });
});
