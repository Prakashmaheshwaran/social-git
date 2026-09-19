import assert from "node:assert/strict";
import test from "node:test";
import { copyOneTimeValue } from "../one-time-secrets.js";

test("copyOneTimeValue reports true when the clipboard write succeeds", async () => {
  const written = [];
  const clipboard = { writeText: async (value) => { written.push(value); } };
  assert.equal(await copyOneTimeValue("sgk_one_time_secret", clipboard), true);
  assert.deepEqual(written, ["sgk_one_time_secret"]);
});

test("copyOneTimeValue reports false and writes nothing when the clipboard rejects", async () => {
  const written = [];
  const clipboard = {
    writeText: async (value) => { written.push(value); throw new Error("clipboard blocked"); },
  };
  assert.equal(await copyOneTimeValue("sgk_one_time_secret", clipboard), false);
  assert.deepEqual(written, ["sgk_one_time_secret"]);
});

test("copyOneTimeValue reports false without a usable clipboard or value", async () => {
  assert.equal(await copyOneTimeValue("sgk_one_time_secret", null), false);
  assert.equal(await copyOneTimeValue("sgk_one_time_secret", undefined), false);
  assert.equal(await copyOneTimeValue("sgk_one_time_secret", {}), false);
  assert.equal(await copyOneTimeValue("", { writeText: async () => {} }), false);
});
