import test from "node:test";
import assert from "node:assert/strict";
import { observeWindowVisibility } from "../shared/window-visibility.mjs";

function bridge() {
  let resolve,
    reject,
    listener,
    unsubscribed = false;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {
    desktop: {
      subscribeVisibility(callback) {
        listener = callback;
        return () => {
          unsubscribed = true;
        };
      },
      invoke(action) {
        assert.equal(action, "visibility");
        return promise;
      },
    },
    resolve: (value) => resolve(value),
    reject: () => reject(new Error("window closed")),
    emit: (value) => listener(value),
    unsubscribed: () => unsubscribed,
  };
}

test("initial window visibility is delivered when no newer event has arrived", async () => {
  const host = bridge(),
    values = [];
  const stop = observeWindowVisibility(host.desktop, (value) =>
    values.push(value),
  );
  host.resolve(false);
  await new Promise(setImmediate);
  host.emit(true);
  assert.deepEqual(values, [false, true]);
  stop();
  assert.equal(host.unsubscribed(), true);
});

test("late initial visibility cannot undo a newer show or hide event", async () => {
  for (const visible of [true, false]) {
    const host = bridge(),
      values = [];
    const stop = observeWindowVisibility(host.desktop, (value) =>
      values.push(value),
    );
    host.emit(visible);
    host.resolve(!visible);
    await new Promise(setImmediate);
    assert.deepEqual(values, [visible]);
    stop();
  }
});

test("disposed observers ignore pending replies and late events", async () => {
  const host = bridge(),
    values = [];
  const stop = observeWindowVisibility(host.desktop, (value) =>
    values.push(value),
  );
  stop();
  host.emit(true);
  host.resolve(false);
  await new Promise(setImmediate);
  assert.deepEqual(values, []);
  assert.equal(host.unsubscribed(), true);
});

test("failed initial visibility does not prevent subsequent native events", async () => {
  const host = bridge(),
    values = [];
  const stop = observeWindowVisibility(host.desktop, (value) =>
    values.push(value),
  );
  host.reject();
  await new Promise(setImmediate);
  host.emit(true);
  assert.deepEqual(values, [true]);
  stop();
});
