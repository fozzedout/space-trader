import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

test('playtest client assets exist', () => {
  for (const file of ['index.html', 'app.js', 'styles.css']) {
    assert.equal(existsSync(join(root, file)), true, file);
  }
});

test('client covers auth, dock, and core loop surfaces', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const js = readFileSync(join(root, 'app.js'), 'utf8');
  assert.match(html, /Space Trader Online/);
  assert.match(html, /auth-email/);
  assert.match(html, /btn-refuel/);
  assert.match(html, /btn-repair/);
  assert.match(html, /data-tab="market"/);
  assert.match(html, /data-tab="travel"/);
  assert.match(html, /id="encounter"/);
  assert.match(js, /\/auth\/request-link/);
  assert.match(js, /\/auth\/verify/);
  assert.match(js, /\/admin\/bootstrap/);
  assert.match(js, /\/captains\/.*\/trade/);
  assert.match(js, /dock\/refuel/);
  assert.match(js, /dock\/repair/);
  assert.match(js, /dock\/upgrade/);
  assert.match(js, /travel\/start/);
  assert.match(js, /systems\/.*\/match/);
  assert.match(js, /encounters\/.*\/action/);
  assert.match(js, /visibilitychange/);
  assert.match(js, /\/auth\/me/);
  assert.match(js, /Captain retired — starting a new captain/);
  assert.doesNotMatch(js, /captain-human-1/);
});
