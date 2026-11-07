import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { createPinnedHttpsConnector } from "../src/index.mjs";

// Guards the {all: true} lookup contract: only Node's real https.request -> net path exercises
// that callback shape, so the fake-requestImpl tests can never see a single-address regression.
test("pinned HTTPS connector reaches the pinned address through Node's real lookup path", async (t) => {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  const connector = createPinnedHttpsConnector({ headers: {} });
  await assert.rejects(
    () => connector({
      method: "GET",
      url: `https://www.reddit.com:${port}/`,
      body: null,
      selectedAddress: "127.0.0.1",
      serverName: "www.reddit.com",
      signal: AbortSignal.timeout(5000),
      headers: {}
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.notEqual(error.code, "ERR_INVALID_IP_ADDRESS");
      return true;
    }
  );
  assert.equal(connections, 1);
});
