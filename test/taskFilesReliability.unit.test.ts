import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { taskLoadSucceeded, taskMutationSucceeded } from "../web/src/TaskBoard.tsx";
import { channelFilesSucceeded } from "../web/src/views/Chat.tsx";

test("task responses distinguish successful data and mutations from HTTP error JSON", () => {
  assert.equal(taskLoadSucceeded({ tasks: [] }), true);
  assert.equal(taskLoadSucceeded({ error: "forbidden" }), false);
  assert.equal(taskLoadSucceeded(null), false);
  assert.equal(taskMutationSucceeded({ ok: true }), true);
  assert.equal(taskMutationSucceeded({ ok: false }), false);
  assert.equal(taskMutationSucceeded({ error: "already claimed" }), false);
});

test("file lists reject error JSON and expose loading, failure, and retry UI", () => {
  assert.equal(channelFilesSucceeded({ files: [] }), true);
  assert.equal(channelFilesSucceeded({ error: "forbidden" }), false);
  const source = fs.readFileSync(new URL("../web/src/views/Chat.tsx", import.meta.url), "utf8");
  assert.match(source, /state === "loading"/);
  assert.match(source, /state === "error"/);
  assert.match(source, /className="files-loading" role="status"/);
  assert.match(source, /title=\{t\("chat\.filesLoadFailed"\)\}/);
  assert.match(source, /onClick=\{\(\) => void load\(\)\}/);
});

test("task optimistic status changes restore the prior snapshot and expose retry", () => {
  const source = fs.readFileSync(new URL("../web/src/TaskBoard.tsx", import.meta.url), "utf8");
  assert.match(source, /const previousStatus = live\.taskStatus \|\| "todo";/);
  assert.match(source, /item\.id === task\.id \? \{ \.\.\.item, taskStatus: previousStatus \}/);
  assert.match(source, /failAction\(\(\) => moveTask\(task, status\)\)/);
  assert.match(source, /className="task-action-error" role="alert"/);
  assert.match(source, /loadState === "loading"/);
  assert.match(source, /loadState === "error"/);
});

test("task status menus and creation dialogs expose keyboard and submitting contracts", () => {
  const source = fs.readFileSync(new URL("../web/src/TaskBoard.tsx", import.meta.url), "utf8");
  assert.match(source, /className="st-menu" role="menu"/);
  assert.match(source, /\["ArrowDown", "ArrowUp", "Home", "End"\]/);
  assert.match(source, /role="dialog" aria-modal="true" aria-labelledby="new-task-title"/);
  assert.match(source, /aria-busy=\{submitting\}/);
  assert.match(source, /if \(!submitting\) onClose\(\)/);
  assert.match(source, /task\.taskAssigneeType === "user"/);
  assert.match(source, /sessionStorage\.setItem\("open-tag\.tasks\.view", next\)/);
});
