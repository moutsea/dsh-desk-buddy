import assert from "node:assert/strict";

export function desktopHost() {
  const listeners = new Map(),
    calls = [];
  const sessions = new Map([
    [
      "s1",
      {
        sessionId: "s1",
        title: "Desktop usage",
        running: false,
        blank: false,
        updatedAt: Date.now(),
        projections: { asOfSeq: 9, values: {} },
      },
    ],
  ]);
  const controls = new Set();
  const peer = {
    principal: { kind: "owner" },
    dispose: async () => {
      peer.disposed = true;
    },
  };
  let publish;
  const gateway = {
    async invoke(call) {
      assert.equal(call.peer, peer);
      calls.push(call);
      if (call.method === "list") {
        assert.deepEqual(call.args, { _request: {} });
        return {
          items: [...sessions.values()].map(({ listProjections, ...row }) => ({
            ...row,
            projections: listProjections ?? row.projections,
          })),
        };
      }
      if (call.method === "page")
        return { records: [{ event: { seq: 1 } }], hasMore: true };
      if (call.method === "modelCatalog") {
        assert.deepEqual(call.args, {});
        return {
          default: { provider: "deepseek", model: "deepseek-v4.1-flash" },
          routableProviders: ["deepseek"],
          groups: [
            {
              id: "deepseek",
              name: "DeepSeek",
              models: [
                { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
                { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
              ],
            },
          ],
          failures: [],
        };
      }
      if (call.method === "projections") {
        const row = sessions.get(call.args.request.sessionId);
        return row
          ? {
              kind: "sequenced",
              asOfSeq: row.projections.asOfSeq,
              modelSelectionSeq: row.projections.modelSelectionSeq,
              values: row.projections.values,
            }
          : null;
      }
      if (call.method === "selectModel") {
        const row = sessions.get(call.args.request.sessionId);
        const selected = {
          provider: call.args.request.provider,
          model: call.args.request.model,
          ...(call.args.request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: call.args.request.reasoningEffort }),
        };
        if (row) {
          row.projections = {
            asOfSeq: row.projections.asOfSeq + 1,
            modelSelectionSeq: row.projections.asOfSeq + 1,
            values: { modelSelection: { next: selected } },
          };
        }
        return { selected };
      }
      return { sessionId: "s1" };
    },
    async stream(call) {
      assert.equal(call.peer, peer);
      assert.equal(call.namespace, "session");
      calls.push(call);
      if (call.method === "control") {
        assert.deepEqual(call.args, {});
        const channel = {
          queue: [],
          ended: false,
          wake: null,
          push(frame) {
            this.queue.push(frame);
            this.wake?.();
          },
          end() {
            this.ended = true;
            this.wake?.();
          },
        };
        controls.add(channel);
        const aborted = () => channel.wake?.();
        call.signal.addEventListener("abort", aborted);
        return (async function* () {
          try {
            yield {
              type: "baseline",
              value: {
                projections: Object.fromEntries(
                  [...sessions].map(([id, row]) => [id, row.projections]),
                ),
              },
            };
            while (!call.signal.aborted && !channel.ended) {
              if (!channel.queue.length)
                await new Promise((resolve) => {
                  channel.wake = resolve;
                });
              while (channel.queue.length && !call.signal.aborted)
                yield channel.queue.shift();
            }
          } finally {
            call.signal.removeEventListener("abort", aborted);
            controls.delete(channel);
          }
        })();
      }
      assert.equal(call.method, "follow");
      const row = sessions.get(call.args.request.address.sessionId);
      return (async function* () {
        try {
          yield {
            type: "snapshot",
            cursor: 9,
            records: [{ event: { seq: 9 } }],
            hasMore: false,
            projections: row.projections,
          };
        } finally {
          gateway.followClosed = true;
        }
      })();
    },
    wireStream: {
      async open(endpoint, payload, uplink, gotPeer, signal) {
        assert.equal(endpoint, "$events");
        assert.equal(gotPeer, peer);
        const queue = [];
        let wake;
        publish = (value) => {
          queue.push(value);
          wake?.();
        };
        return (async function* () {
          yield { type: "ready", clientId: "client" };
          const aborted = () => wake?.();
          signal.addEventListener("abort", aborted);
          try {
            while (!signal.aborted) {
              if (!queue.length)
                await new Promise((resolve) => {
                  wake = resolve;
                });
              while (queue.length) yield queue.shift();
            }
          } finally {
            signal.removeEventListener("abort", aborted);
          }
        })();
      },
    },
    async dispatchRpc(endpoint, payload, signal, gotPeer) {
      assert.equal(gotPeer, peer);
      calls.push({ endpoint, payload });
      return { ok: true };
    },
  };
  return {
    ctx: {
      get: () => gateway,
      connection: { createPeer: () => peer },
      credentials: { resolve: async () => null },
      on: (event, fn) => {
        listeners.set(event, fn);
        return () => listeners.delete(event);
      },
    },
    calls,
    sessions,
    controls,
    publishControl(frame) {
      for (const channel of controls) channel.push(frame);
    },
    endControl() {
      for (const channel of controls) channel.end();
    },
    gateway,
    peer,
    publish: (value) => publish(value),
    emit: (event, ...args) => listeners.get(event)?.(...args),
    listeners,
  };
}
