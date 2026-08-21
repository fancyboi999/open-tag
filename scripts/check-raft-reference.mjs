import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../references/raft-baseline/', import.meta.url);
const matrix = JSON.parse(await readFile(new URL('matrix.json', root), 'utf8'));
const evidence = JSON.parse(
  await readFile(new URL('representative-evidence.json', root), 'utf8'),
);
const schema = JSON.parse(await readFile(new URL('evidence.schema.json', root), 'utf8'));

assert.deepEqual(
  matrix.viewports.map(({ width, height }) => `${width}x${height}`),
  ['1440x900', '390x844', '375x812'],
);
assert.deepEqual(
  matrix.breakpoints.map(({ width, mode }) => `${width}:${mode}`),
  ['768:desktop', '767:mobile'],
);

const requiredKinds = new Set(['public', 'auth', 'workspace-root', 'detail']);
const catalogStates = new Set(matrix.stateCatalog);
for (const page of matrix.pages) {
  requiredKinds.delete(page.kind);
  assert.ok(page.id && page.route && page.precondition, `incomplete page ${page.id}`);
  assert.ok(page.states.length > 0, `page ${page.id} has no states`);
  for (const state of page.states) {
    assert.ok(catalogStates.has(state), `${page.id} uses uncatalogued state ${state}`);
  }
  const coverage = new Set([...page.observed, ...page.gaps]);
  assert.equal(
    page.observed.length + page.gaps.length,
    coverage.size,
    `${page.id} lists a viewport as both observed and gap`,
  );
  for (const viewport of matrix.viewports) {
    assert.ok(coverage.has(viewport.id), `${page.id} omits ${viewport.id}`);
  }
}
assert.equal(requiredKinds.size, 0, `missing page kinds: ${[...requiredKinds]}`);
assert.deepEqual(
  new Set(schema.properties.state.enum),
  catalogStates,
  'evidence schema and matrix state catalogs differ',
);

const representedStates = new Set(Object.keys(evidence.stateEvidence));
for (const state of matrix.stateCatalog) {
  assert.ok(representedStates.has(state), `missing representative state: ${state}`);
}

assert.equal(evidence.environment.deviceScaleFactor, 1);
assert.equal(evidence.environment.pageScaleFactor, 1);
assert.equal(evidence.noiseCalibration.samples, 3);
assert.equal(evidence.thresholds.criticalEdgeMaximumDeltaCssPx, 2);
assert.equal(evidence.thresholds.maximumHorizontalOverflowCssPx, 0);
assert.ok(evidence.thresholds.fullPageMinimumSsim >= 0.995);
assert.ok(evidence.thresholds.criticalRegionMinimumSsim >= 0.998);
assert.equal(schema.properties.theme.const, 'light');
assert.equal(
  schema.properties.viewportId.enum.length,
  matrix.viewports.length,
  'evidence schema and matrix viewport counts differ',
);

console.log(
  `Raft reference baseline OK: ${matrix.pages.length} pages, ${matrix.viewports.length} required viewports, ${matrix.stateCatalog.length} representative states.`,
);
