import assert from "node:assert/strict";
import { test } from "node:test";
import * as plugin from "../index.js";
import { onPostBuild, onSuccess } from "../lib.js";

// Netlify Build fails with "Invalid event" for any other named export of the plugin entry module.
const NETLIFY_EVENTS = ["onPreBuild", "onBuild", "onPostBuild", "onSuccess", "onError", "onEnd"];

test("the entry module exports only Netlify event handlers", () => {
  for (const name of Object.keys(plugin)) {
    assert.ok(NETLIFY_EVENTS.includes(name), `unexpected export "${name}"`);
  }
  assert.deepEqual(Object.keys(plugin).sort(), ["onPostBuild", "onSuccess"]);
});

test("the entry module re-exports the lib.js handlers", () => {
  assert.equal(typeof plugin.onPostBuild, "function");
  assert.equal(typeof plugin.onSuccess, "function");
  assert.equal(plugin.onPostBuild, onPostBuild);
  assert.equal(plugin.onSuccess, onSuccess);
});
