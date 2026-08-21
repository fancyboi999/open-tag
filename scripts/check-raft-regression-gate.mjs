import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const repo = new URL('../', import.meta.url);
const reference = new URL('references/raft-baseline/', repo);
const comparisons = new URL('comparisons/', reference);
const matrix = JSON.parse(await readFile(new URL('matrix.json', reference), 'utf8'));
const representative = JSON.parse(await readFile(new URL('representative-evidence.json', reference), 'utf8'));
const schema = JSON.parse(await readFile(new URL('evidence.schema.json', reference), 'utf8'));
const gate = JSON.parse(await readFile(new URL('315-regression-rollback-gate.json', comparisons), 'utf8'));

assert.equal(matrix.pages.length, 30);
assert.equal(matrix.viewports.length, 3);
assert.equal(matrix.stateCatalog.length, 14);
for (const page of matrix.pages) {
  assert.deepEqual(page.observed, matrix.viewports.map(({ id }) => id), `${page.id} is not observed at every viewport`);
  assert.deepEqual(page.gaps, [], `${page.id} still has a coverage gap`);
}
assert.deepEqual(new Set(schema.properties.state.enum), new Set(matrix.stateCatalog));

const comparisonNames = [
  '305-shell-routing.json',
  '306-desktop-shell.json',
  '307-mobile-workspace-home.json',
  '308-mobile-detail-navigation.json',
  '309-chat-collaboration.json',
  '310-tasks-files.json',
  '311-search-activity-saved-showcase.json',
  '312-members-profiles.json',
  '313-settings-account-invites-notifications-machines.json',
  '314-public-auth-bootstrap.json',
  '315-regression-rollback-gate.json',
];
await Promise.all(comparisonNames.map((name) => readFile(new URL(name, comparisons), 'utf8')));

assert.deepEqual(gate.matrix.ticketComparisons, Array.from({ length: 11 }, (_, index) => index + 305));
assert.equal(gate.matrix.pages, matrix.pages.length);
assert.equal(gate.matrix.viewports, matrix.viewports.length);
assert.equal(gate.matrix.states, matrix.stateCatalog.length);
assert.equal(gate.matrix.gaps, 0);
assert.equal(gate.matrix.artifactFiles, 84);
assert.match(gate.matrix.manifestSha256, /^[a-f0-9]{64}$/);

const locked = gate.lockedThresholds;
assert.equal(locked.fullPageMinimumSsim, representative.thresholds.fullPageMinimumSsim);
assert.equal(locked.fullPageMaximumChangedPixelRatio, representative.thresholds.fullPageMaximumChangedPixelRatio);
assert.equal(locked.criticalRegionMinimumSsim, representative.thresholds.criticalRegionMinimumSsim);
assert.equal(locked.criticalRegionMaximumChangedPixelRatio, representative.thresholds.criticalRegionMaximumChangedPixelRatio);
assert.equal(locked.criticalEdgeMaximumDeltaCssPx, 2);
assert.equal(locked.maximumHorizontalOverflowCssPx, 0);
assert.ok(locked.actualMaximumCriticalEdgeDeltaCssPx <= locked.criticalEdgeMaximumDeltaCssPx);
assert.equal(locked.actualMaximumHorizontalOverflowCssPx, 0);
assert.equal(locked.result, 'pass');

assert.equal(gate.journeys.desktop.result, 'pass');
assert.equal(gate.journeys.mobile.result, 'pass');
assert.equal(gate.journeys.network.result, 'pass');
assert.equal(gate.journeys.network.reconnected, true);
assert.equal(gate.journeys.network.unexpectedPostRecoveryErrors, 0);
assert.equal(gate.journeys.runtimeStates.result, 'pass');
assert.deepEqual(gate.browserDiagnostics, {
  unexpectedConsoleErrors: 0,
  pageExceptions: 0,
  hydrationWarnings: 0,
  horizontalOverflowCssPx: 0,
});
assert.equal(gate.regression.typecheck, 'pass');
assert.equal(gate.regression.productionBuild.result, 'pass');
assert.equal(gate.regression.fullUnit.result, 'pass');
assert.equal(gate.regression.fullUnit.failed, 0);
assert.equal(gate.rollback.previewClassicQuery.result, 'pass');
assert.equal(gate.rollback.productionForcedBaselineQuery.baselineClass, false);
assert.equal(gate.rollback.productionCapability, 'disabled');
assert.equal(gate.protectedSurfaceDiff.result, 'pass');
assert.equal(gate.protectedSurfaceDiff.serverDatabaseRestSocketDaemonAgentRuntimeConnectorChanges, 0);
assert.equal(gate.protectedSurfaceDiff.binaryAssetsAddedOrModified, 0);
assert.ok(gate.intentionalDifferences.length >= 4);
for (const difference of gate.intentionalDifferences) {
  assert.ok(difference.kind && difference.reason && difference.owner && difference.selectors.length > 0);
}
assert.ok(gate.excluded.includes('VIBES visual redesign'));

const css = await readFile(new URL('web/src/baselineShell.css', repo), 'utf8');
assert.match(css, /safe-area-inset-bottom/);
const vite = await readFile(new URL('web/vite.config.ts', repo), 'utf8');
assert.match(vite, /mode === "development" \|\| mode === "preview" \? "enabled" : "disabled"/);

const changed = execFileSync('git', ['diff', '--name-only', gate.baseCommit], {
  cwd: repo,
  encoding: 'utf8',
}).trim().split('\n').filter(Boolean);
const protectedPath = /^(src|daemon|connectors|migrations)(\/|$)/;
assert.deepEqual(changed.filter((path) => protectedPath.test(path)), [], 'protected runtime surface changed');
const binaryAsset = /\.(?:png|jpe?g|gif|webp|woff2?|ttf|otf|ico)$/i;
assert.deepEqual(changed.filter((path) => binaryAsset.test(path)), [], 'binary/private asset changed');

console.log(
  `Raft regression gate OK: ${matrix.pages.length} pages x ${matrix.viewports.length} viewports, ${matrix.stateCatalog.length} states, ${gate.regression.fullUnit.passed} unit tests, protected diff clean.`,
);
