import { test } from "node:test";
import assert from "node:assert/strict";
import { ResourceBudget } from "./resourceBudget.js";

test("ResourceBudget constructor uses provided values", () => {
  const b = new ResourceBudget({ totalMemMB: 8000, totalCpuCores: 4 });
  assert.equal(b.totalMemMB, 8000);
  assert.equal(b.totalCpuCores, 4);
  assert.equal(b.reserveMemPct, 0.2);
  assert.equal(b.reserveCpuPct, 0.25);
  assert.equal(b.maxAgentMemMB, 6400);
  assert.equal(b.maxAgentCpuPct, 300);
});

test("canAllocate returns true when under budget", () => {
  const b = new ResourceBudget({ totalMemMB: 8000, totalCpuCores: 4 });
  assert.equal(b.canAllocate(1000, 50), true);
});

test("canAllocate returns false when memory over budget", () => {
  const b = new ResourceBudget({ totalMemMB: 1000, totalCpuCores: 4 });
  b.allocate(700, 0);
  // maxAgentMemMB = 800, allocated = 700, need 200 > 100 available
  assert.equal(b.canAllocate(200, 0), false);
  assert.equal(b.canAllocate(100, 0), true);
});

test("canAllocate returns false when CPU over budget", () => {
  const b = new ResourceBudget({ totalMemMB: 8000, totalCpuCores: 2 });
  b.allocate(0, 120);
  // maxAgentCpuPct = 150, allocated = 120, need 50 > 30 available
  assert.equal(b.canAllocate(0, 50), false);
  assert.equal(b.canAllocate(0, 30), true);
});

test("allocate and release track correctly", () => {
  const b = new ResourceBudget({ totalMemMB: 8000, totalCpuCores: 4 });
  b.allocate(2000, 100);
  assert.equal(b.allocatedMemMB, 2000);
  assert.equal(b.allocatedCpuPct, 100);
  b.allocate(1000, 50);
  assert.equal(b.allocatedMemMB, 3000);
  assert.equal(b.allocatedCpuPct, 150);
  b.release(1000, 50);
  assert.equal(b.allocatedMemMB, 2000);
  assert.equal(b.allocatedCpuPct, 100);
});

test("release does not go below zero", () => {
  const b = new ResourceBudget({ totalMemMB: 8000, totalCpuCores: 4 });
  b.release(100, 50);
  assert.equal(b.allocatedMemMB, 0);
  assert.equal(b.allocatedCpuPct, 0);
});

test("zero limits always pass budget check", () => {
  const b = new ResourceBudget({ totalMemMB: 1000, totalCpuCores: 1 });
  b.allocate(790, 70);
  // maxAgentMemMB = 800, maxAgentCpuPct = 75
  assert.equal(b.canAllocate(0, 0), true);
  assert.equal(b.canAllocate(0, 5), true); // 70+5 = 75 still OK
  assert.equal(b.canAllocate(0, 6), false); // 70+6 = 76 > 75
});

test("status returns correct values", () => {
  const b = new ResourceBudget({ totalMemMB: 8000, totalCpuCores: 4 });
  b.allocate(2000, 100);
  b.queueLength = 3;
  const s = b.status();
  assert.equal(s.totalMemMB, 8000);
  assert.equal(s.availableMemMB, 4400);
  assert.equal(s.availableCpuPct, 200);
  assert.equal(s.queueLength, 3);
});
