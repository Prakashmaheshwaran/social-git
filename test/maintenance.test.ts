import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeMaintenanceGate } from "../src/maintenance.ts";

test("maintenance gate drains admitted work and rejects new work until writers resume", async () => {
  const gate = new RuntimeMaintenanceGate();
  const firstLease = gate.tryEnter();
  assert.ok(firstLease);
  const events: string[] = [];
  const maintenance = gate.runExclusive({
    pause: async () => { events.push("paused"); },
    task: () => { events.push("snapshot"); return "complete"; },
    resume: () => { events.push("resumed"); },
  });
  assert.equal(gate.active, true);
  assert.equal(gate.tryEnter(), null, "new work must fail closed once maintenance admission closes");
  assert.deepEqual(events, [], "snapshot must wait for already admitted work");
  firstLease();
  assert.equal(await maintenance, "complete");
  assert.deepEqual(events, ["paused", "snapshot", "resumed"]);
  assert.equal(gate.active, false);
  const after = gate.tryEnter();
  assert.ok(after);
  after();
});
