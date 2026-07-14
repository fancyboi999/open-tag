import { test } from "node:test";
import assert from "node:assert/strict";
import { ResourceBudget } from "./resourceBudget.js";

test("ResourceBudget constructor uses provided values", () => {
  const b = new ResourceBudget({ totalMemMB: 8000, totalCpuCores: 4 });
  assert.equal(b.totalMemMB, 8000);
  assert.equal(b.totalCpuCores, 4);
});

test("canAllocate returns true when above pressure threshold", () => {
  const b = new ResourceBudget({ totalMemMB: 8000, totalCpuCores: 4, availableMemMB: () => 600 });
  assert.equal(b.canAllocate(), true);
});

test("canAllocate returns false when below pressure threshold", () => {
  const b = new ResourceBudget({ totalMemMB: 8000, totalCpuCores: 4, availableMemMB: () => 400 });
  assert.equal(b.canAllocate(), false);
});

test("status returns correct shape", () => {
  const b = new ResourceBudget({ totalMemMB: 8000, totalCpuCores: 4, availableMemMB: () => 1000 });
  b.queueLength = 3;
  b.agentCount = 5;
  const s = b.status();
  assert.equal(s.totalMemMB, 8000);
  assert.equal(s.availableMemMB, 1000);
  assert.equal(s.queueLength, 3);
  assert.equal(s.agentCount, 5);
});

test("queueLength increments and decrements", () => {
  const b = new ResourceBudget({ totalMemMB: 8000, totalCpuCores: 4 });
  assert.equal(b.queueLength, 0);
  b.queueLength = 2;
  assert.equal(b.queueLength, 2);
  b.queueLength = 1;
  assert.equal(b.queueLength, 1);
});
