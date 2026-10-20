import { expect } from "@playwright/test";

// Hold one already-serialized HTTP response in the Electron main process.
// Later requests proceed normally, allowing deterministic response reordering.
export async function holdResponse(app, path) {
  await app.evaluate((_, path) => {
    if (!globalThis.heldTestResponse) {
      globalThis.heldTestResponse = {};
      const original = globalThis.fetch;
      globalThis.fetch = async (...args) => {
        const response = await original(...args);
        const hold = globalThis.heldTestResponse;
        if (new URL(args[0]).pathname === hold.path) {
          hold.path = null;
          await new Promise((resolve) => {
            hold.release = resolve;
          });
        }
        return response;
      };
    }
    globalThis.heldTestResponse = { path, release: null };
  }, path);
  return {
    wait: () =>
      expect
        .poll(() =>
          app.evaluate(
            () => typeof globalThis.heldTestResponse.release === "function",
          ),
        )
        .toBe(true),
    release: () => app.evaluate(() => globalThis.heldTestResponse.release()),
  };
}

// Hold requests before they reach the host, so their snapshots can advance
// independently of request initiation order. Later requests proceed normally.
export async function holdRequests(app, path, count) {
  await app.evaluate(
    (_, { path, count }) => {
      if (!globalThis.heldTestRequests) {
        globalThis.heldTestRequests = {};
        const original = globalThis.fetch;
        globalThis.fetch = async (...args) => {
          const hold = globalThis.heldTestRequests;
          if (new URL(args[0]).pathname === hold.path && hold.remaining > 0) {
            hold.remaining--;
            await new Promise((resolve) => hold.releases.push(resolve));
          }
          return original(...args);
        };
      }
      globalThis.heldTestRequests = { path, remaining: count, releases: [] };
    },
    { path, count },
  );
  return {
    wait: (count) =>
      expect
        .poll(() =>
          app.evaluate(() => globalThis.heldTestRequests.releases.length),
        )
        .toBe(count),
    release: (index) =>
      app.evaluate(
        (_, index) => globalThis.heldTestRequests.releases[index](),
        index,
      ),
  };
}
