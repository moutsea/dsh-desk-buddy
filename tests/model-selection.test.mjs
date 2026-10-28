import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { SessionClients, sessionKey } from "../shared/session-clients.mjs";
import { createFixture } from "./fixture.mjs";
import { createCodexHost } from "./helpers/codex-host.mjs";

async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await delay(10);
  }
  throw Error("timeout");
}

async function connect(t, provider, endpoint, prepare) {
  const client = new SessionClients();
  t.after(() => client.close());
  await client.connect(provider, endpoint);
  await until(() => client.connections()[provider].status === "connected");
  await prepare?.();
  await client.rpc("session.list");
  return client;
}

test("DSH exposes its model directory and switches the session selection", async (t) => {
  const dsh = await createFixture();
  t.after(() => dsh.close());
  dsh.sessions.set("session", {
    sessionId: "session",
    cwd: "/tmp",
    running: false,
    blank: false,
    updatedAt: Date.now(),
    events: [],
  });
  const client = await connect(t, "dsh", dsh.endpoint);

  const directory = await client.rpc("session.models", {
    sessionId: "session",
  });
  assert.deepEqual(directory.current, {
    provider: "deepseek",
    model: "deepseek-v4.1-flash",
  });
  assert.equal(directory.routable, true);
  assert.deepEqual(
    directory.groups.map((group) => ({
      id: group.id,
      models: group.models.map((model) => model.id),
    })),
    [
      {
        id: "deepseek",
        models: ["deepseek-v4.1-flash", "deepseek-v4-flash"],
      },
    ],
  );

  const result = await client.rpc("session.selectModel", {
    sessionId: "session",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
  });
  assert.deepEqual(result.selected, {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
  });
  assert.deepEqual(dsh.sessions.get("session").model, result.selected);
  assert.ok(dsh.calls.some((call) => call.path === "/api/session.selectModel"));
});

test("Codex preserves authoritative settings notifications before selection acknowledgement", async (t) => {
  const codex = await createCodexHost();
  t.after(() => codex.close());
  const thread = codex.add("thread-settings");
  thread.model = "preset-test-low";
  thread.modelProvider = "openai";
  thread.reasoningEffort = "high";
  codex.handler = async (frame) => {
    if (frame.method === "thread/settings/update")
      codex.notify("thread/settings/updated", {
        threadId: "thread-settings",
        threadSettings: {
          model: "server-normalized-model",
          modelProvider: "openai",
          effort: null,
        },
      });
  };
  const client = await connect(t, "codex", codex.endpoint);
  const id = sessionKey("codex", "thread-settings");
  const result = await client.rpc("session.selectModel", {
    sessionId: id,
    provider: "openai",
    model: "requested-alias",
    reasoningEffort: "low",
  });
  assert.deepEqual(result.selected, {
    provider: "openai",
    model: "server-normalized-model",
  });
  assert.deepEqual((await client.rpc("session.models", { sessionId: id })).current, {
    provider: "openai",
    model: "server-normalized-model",
  });
});

test("Codex treats an ack-first duplicate settings notification as confirmation", async (t) => {
  const codex = await createCodexHost();
  t.after(() => codex.close());
  const thread = codex.add("thread-ack-first");
  thread.model = "preset-test-low";
  thread.modelProvider = "openai";
  thread.reasoningEffort = "high";
  let revisions = 0;
  let projections = 0;
  codex.handler = async (frame) => {
    if (frame.method === "thread/settings/update") {
      // A late authoritative notification echoes the requested settings after
      // the RPC acknowledgement has already been applied.
      queueMicrotask(() =>
        codex.notify("thread/settings/updated", {
          threadId: "thread-ack-first",
          threadSettings: {
            model: "preset-test-high",
            modelProvider: "openai",
            effort: "high",
          },
        }),
      );
    }
  };
  const client = await connect(t, "codex", codex.endpoint);
  const id = sessionKey("codex", "thread-ack-first");
  client.on("frame", ({ payload }) => {
    if (payload.type === "session/projection" && payload.key === "modelSelection") {
      projections++;
      if (payload.seq !== undefined) assert.ok(payload.seq > revisions);
      revisions++;
    }
  });
  const result = await client.rpc("session.selectModel", {
    sessionId: id,
    provider: "openai",
    model: "preset-test-high",
    reasoningEffort: "high",
  });
  assert.deepEqual(result.selected, {
    provider: "openai",
    model: "preset-test-high",
    reasoningEffort: "high",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    projections,
    1,
    "an identical late notification must not re-broadcast the selection",
  );
  assert.deepEqual(
    (await client.rpc("session.models", { sessionId: id })).current,
    result.selected,
  );
});

test("Codex lists models and applies the selection to subsequent turns", async (t) => {
  const codex = await createCodexHost();
  t.after(() => codex.close());
  const thread = codex.add("thread-1");
  thread.model = "preset-test-low";
  thread.modelProvider = "openai";
  thread.reasoningEffort = "low";
  const stored = codex.add("stored");
  stored.status = { type: "notLoaded" };
  stored.model = "preset-test-low";
  stored.modelProvider = "openai";
  const client = await connect(t, "codex", codex.endpoint);
  const id = sessionKey("codex", "thread-1");

  const directory = await client.rpc("session.models", { sessionId: id });
  assert.deepEqual(directory.current, {
    provider: "openai",
    model: "preset-test-low",
    reasoningEffort: "low",
  });
  assert.equal(directory.routable, true);
  assert.deepEqual(
    directory.groups[0].models.map((model) => model.id),
    ["preset-test-low", "preset-test-high"],
  );
  assert.deepEqual(directory.groups[0].models[0].reasoning, {
    efforts: [
      { id: "low", name: "low", description: "快速" },
      { id: "high", name: "high", description: "深入" },
    ],
    defaultEffort: "low",
  });

  const result = await client.rpc("session.selectModel", {
    sessionId: id,
    provider: "openai",
    model: "preset-test-high",
    reasoningEffort: "high",
  });
  assert.deepEqual(result.selected, {
    provider: "openai",
    model: "preset-test-high",
    reasoningEffort: "high",
  });
  const update = codex.calls.find(
    (call) => call.method === "thread/settings/update",
  );
  assert.deepEqual(update.params, {
    threadId: "thread-1",
    model: "preset-test-high",
    effort: "high",
  });
  assert.equal(codex.sessions.get("thread-1").model, "preset-test-high");
  assert.deepEqual(
    (await client.rpc("session.models", { sessionId: id })).current,
    result.selected,
  );
  await client.rpc("session.prompt", {
    sessionId: id,
    content: [{ type: "text", text: "use selected model" }],
  });
  const turnStart = [...codex.calls]
    .reverse()
    .find((call) => call.method === "turn/start");
  assert.equal(turnStart.params.threadId, "thread-1");
  assert.equal(turnStart.params.input[0].text, "use selected model");
  assert.equal(codex.sessions.get("thread-1").model, "preset-test-high");
  assert.equal(codex.sessions.get("thread-1").reasoningEffort, "high");

  await assert.rejects(
    client.rpc("session.selectModel", {
      sessionId: sessionKey("codex", "stored"),
      provider: "openai",
      model: "preset-test-high",
    }),
    /仅支持查看/,
  );
});

// Compile the real component in memory. The small hook host drives the actual
// effects and event handlers without opening a desktop window or emitting files.
let pickerCode;
async function picker(invoke) {
  if (!pickerCode) {
    pickerCode = (async () => {
      const bundle = await rolldown({
        input: fileURLToPath(
          new URL("../src/ModelPicker.tsx", import.meta.url),
        ),
        external: ["react", "react/jsx-runtime", "lucide-react"],
      });
      try {
        const result = await bundle.generate({ format: "cjs" });
        return result.output[0].code;
      } finally {
        await bundle.close();
      }
    })();
  }
  const slots = [];
  let index = 0,
    effects = [];
  const hooks = {
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = { value: initial };
      return [
        slots[slot].value,
        (value) => {
          slots[slot].value =
            typeof value === "function" ? value(slots[slot].value) : value;
        },
      ];
    },
    useRef(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = { current: initial };
      return slots[slot];
    },
    useEffect(callback, deps) {
      const slot = index++;
      const previous = slots[slot];
      if (
        !previous ||
        deps.some((value, i) => !Object.is(value, previous.deps[i]))
      )
        effects.push(() => {
          previous?.cleanup?.();
          slots[slot] = { deps, cleanup: callback() };
        });
    },
  };
  const createElement = (type, props, ...children) => ({
    type,
    props: children.length ? { ...props, children } : props,
  });
  // Automatic JSX runtime passes children inside props and uses the optional
  // third argument for key. Keep that distinct from React.createElement so
  // keyed optgroups/options retain their actual children in this harness.
  const jsx = (type, props, key) => ({
    type,
    props: key === undefined ? props : { ...props, key },
  });
  const jsxs = jsx;
  const module = { exports: {} };
  vm.runInNewContext(await pickerCode, {
    module,
    exports: module.exports,
    Error,
    React: { createElement },
    window: { desktop: { invoke } },
    require(name) {
      if (name === "react") return { ...hooks, createElement };
      if (name === "react/jsx-runtime") return { jsx, jsxs };
      if (name === "lucide-react")
        return { Cpu: "Cpu", ChevronDown: "ChevronDown", RefreshCw: "RefreshCw" };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  return {
    render(props) {
      index = 0;
      const tree = module.exports.ModelPicker(props);
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
      return tree;
    },
    unmount() {
      slots.forEach((slot) => slot.cleanup?.());
    },
  };
}
const model = (id) => ({ provider: "deepseek", model: id });
const directory = (id = "a", failures = []) => ({
  current: model(id),
  routable: true,
  groups: [
    {
      id: "deepseek",
      name: "DeepSeek",
      models: ["a", "b", "c"].map((id) => ({ id, name: id })),
    },
  ],
  failures,
});
const pickerProps = (asOfSeq = 1, modelSelectionSeq = 1) => ({
  state: { config: { provider: "dsh" }, connections: { dsh: { epoch: 1 } } },
  session: {
    sessionId: "session",
    provider: "dsh",
    readOnly: false,
    projections: {
      asOfSeq,
      modelSelectionSeq,
      values: { modelSelection: { next: model("a") } },
    },
  },
  connected: true,
  active: true,
  busy: false,
  onSelect: async (value) => ({ selected: value }),
  onError: (message) => assert.fail(message),
});
function control(tree, type) {
  return tree.props.children.flat(Infinity).find((node) => node?.type === type);
}
function selectOptions(tree) {
  const select = control(tree, "select");
  const walk = (node) =>
    Array.isArray(node)
      ? node.flatMap(walk)
      : node && typeof node === "object"
        ? [node, ...walk(node.props?.children)]
        : [];
  return walk(select.props.children).filter(
    (node) => node.type === "optgroup" || node.type === "option",
  );
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("model picker retries a failed directory read without a reconnect", async (t) => {
  let reads = 0;
  const component = await picker(async () => {
    if (++reads === 1) throw new Error("temporary unavailable");
    return directory();
  });
  t.after(() => component.unmount());
  const props = pickerProps();
  component.render(props);
  await settle();
  let tree = component.render(props);
  assert.equal(control(tree, "select").props.disabled, true);
  const retry = control(tree, "button");
  assert.equal(retry.props["aria-label"], "重试加载模型");
  assert.equal(retry.props.type, "button", "retry must not submit the composer");
  retry.props.onClick();
  component.render(props);
  await settle();
  tree = component.render(props);
  assert.equal(reads, 2);
  assert.equal(control(tree, "select").props.disabled, false);
  assert.equal(control(tree, "button"), undefined);
  // The automatic JSX harness must keep the real option subtree: every model
  // in the directory stays selectable inside its optgroup.
  assert.equal(
    JSON.stringify(
      selectOptions(tree).map((node) =>
        node.type === "optgroup" ? node.props.label : node.props.value,
      ),
    ),
    JSON.stringify([
      "DeepSeek",
      "deepseek\u0000a",
      "deepseek\u0000b",
      "deepseek\u0000c",
    ]),
  );
});

test("a directory with provider failures shows the error state and a retry entry", async (t) => {
  let reads = 0;
  const component = await picker(async () => {
    ++reads;
    if (reads === 1)
      return {
        ...directory(),
        groups: [],
        failures: [
          { id: "OpenAI", name: "OpenAI", message: "目录请求超时" },
        ],
      };
    return directory();
  });
  t.after(() => component.unmount());
  const props = pickerProps();
  component.render(props);
  await settle();
  let tree = component.render(props);
  assert.equal(control(tree, "select").props.disabled, true);
  const retry = control(tree, "button");
  assert.ok(retry, "a failed provider catalog must expose a retry entry");
  assert.match(retry.props.title, /目录请求超时/);
  retry.props.onClick();
  component.render(props);
  await settle();
  tree = component.render(props);
  assert.equal(reads, 2);
  assert.equal(control(tree, "select").props.disabled, false);
  assert.equal(control(tree, "button"), undefined);
  assert.equal(
    JSON.stringify(selectOptions(tree).map((node) => node.props.value).filter(Boolean)),
    JSON.stringify([
      "deepseek\u0000a",
      "deepseek\u0000b",
      "deepseek\u0000c",
    ]),
  );
});

test("a live same-value projection still invalidates the local receipt", async (t) => {
  const component = await picker(async () => directory());
  t.after(() => component.unmount());
  let props = pickerProps(1);
  component.render(props);
  await settle();
  let tree = component.render(props);
  control(tree, "select").props.onChange({ target: { value: "deepseek\u0000b" } });
  await settle();
  tree = component.render(props);
  assert.equal(control(tree, "select").props.value, "deepseek\u0000b");
  // A live model event can carry the same value as the old snapshot; its
  // independent watermark still distinguishes the update.
  props = { ...props, session: { ...props.session, projections: { asOfSeq: 3, modelSelectionSeq: 2, values: { modelSelection: { next: model("a") } } } } };
  tree = component.render(props);
  assert.equal(
    control(tree, "select").props.value,
    "deepseek\u0000a",
    "a newer authoritative projection wins even when the value repeats",
  );
});

test("a history snapshot without a model event never invalidates the local receipt", async (t) => {
  const component = await picker(async () => directory());
  t.after(() => component.unmount());
  let props = pickerProps(1);
  component.render(props);
  await settle();
  let tree = component.render(props);
  control(tree, "select").props.onChange({ target: { value: "deepseek\u0000b" } });
  await settle();
  tree = component.render(props);
  assert.equal(control(tree, "select").props.value, "deepseek\u0000b");
  props = {
    ...props,
    session: {
      ...props.session,
      projections: { asOfSeq: 3, modelSelectionSeq: 1, values: { modelSelection: { next: model("a") } } },
    },
  };
  tree = component.render(props);
  assert.equal(
    control(tree, "select").props.value,
    "deepseek\u0000b",
    "a snapshot-only cut must not revoke a live receipt",
  );
});

test("an unrelated projection watermark never revokes the local receipt", async (t) => {
  const component = await picker(async () => directory());
  t.after(() => component.unmount());
  let props = pickerProps(1);
  component.render(props);
  await settle();
  let tree = component.render(props);
  control(tree, "select").props.onChange({ target: { value: "deepseek\u0000b" } });
  await settle();
  tree = component.render(props);
  assert.equal(control(tree, "select").props.value, "deepseek\u0000b");
  // tokenUsage / contextPressure advance the store watermark but carry no
  // modelSelection update of their own; the receipt must survive them.
  props = {
    ...props,
    session: {
      ...props.session,
      projections: {
        asOfSeq: 2,
        modelSelectionSeq: 1,
        values: {
          modelSelection: { next: model("a") },
          tokenUsage: { tokens: 24000 },
        },
      },
    },
  };
  tree = component.render(props);
  assert.equal(
    control(tree, "select").props.value,
    "deepseek\u0000b",
    "an unrelated key's watermark must not invalidate the model receipt",
  );
  // A modelSelection bump at the same watermark cut does invalidate it.
  props = {
    ...props,
    session: {
      ...props.session,
      projections: { ...props.session.projections, modelSelectionSeq: 2 },
    },
  };
  tree = component.render(props);
  assert.equal(control(tree, "select").props.value, "deepseek\u0000a");
});

test("partial provider failures keep healthy groups selectable with a retry entry", async (t) => {
  const component = await picker(async () => ({
    ...directory(),
    failures: [{ id: "openai", name: "OpenAI", message: "目录请求超时" }],
  }));
  t.after(() => component.unmount());
  const props = pickerProps();
  component.render(props);
  await settle();
  const tree = component.render(props);
  assert.equal(
    control(tree, "select").props.disabled,
    false,
    "a healthy provider must stay selectable while another one fails",
  );
  const retry = control(tree, "button");
  assert.ok(retry, "partial failures must expose a retry entry");
  assert.match(retry.props.title, /目录请求超时/);
  assert.match(tree.props.title, /部分供应商失败/);
  assert.equal(
    JSON.stringify(
      selectOptions(tree)
        .map((node) => node.props.value)
        .filter(Boolean),
    ),
    JSON.stringify([
      "deepseek\u0000a",
      "deepseek\u0000b",
      "deepseek\u0000c",
    ]),
  );
});

test("external model projections win over a late directory and local receipt", async (t) => {
  const read = deferred(), write = deferred();
  let writes = 0;
  const component = await picker(() => read.promise);
  t.after(() => component.unmount());
  let props = pickerProps();
  props.onSelect = () => {
    writes++;
    return write.promise;
  };
  component.render(props);
  props = {
    ...props,
    session: {
      ...props.session,
      projections: {
        modelSelectionSeq: 2,
        values: { modelSelection: { next: model("b") } },
      },
    },
  };
  let tree = component.render(props);
  assert.equal(control(tree, "select").props.value, "deepseek\u0000b");
  read.resolve(directory("a"));
  await settle();
  tree = component.render(props);
  assert.equal(control(tree, "select").props.value, "deepseek\u0000b");
  control(tree, "select").props.onChange({ target: { value: "deepseek\u0000a" } });
  assert.equal(writes, 1, "the old displayed model can be selected again");
  props = {
    ...props,
    session: {
      ...props.session,
      projections: {
        modelSelectionSeq: 3,
        values: { modelSelection: { next: model("c") } },
      },
    },
  };
  component.render(props);
  props = {
    ...props,
    session: {
      ...props.session,
      projections: {
        modelSelectionSeq: 4,
        values: { modelSelection: { next: model("b") } },
      },
    },
  };
  component.render(props);
  write.resolve({ selected: model("a") });
  await settle();
  tree = component.render(props);
  assert.equal(
    control(tree, "select").props.value,
    "deepseek\u0000b",
    "an intervening projection still wins when it returns to its original value",
  );
  assert.equal(writes, 1, "external synchronization never writes a selection");
});

test("a stale projection after same-connection reload cannot override the directory", async (t) => {
  const component = await picker(async () => directory());
  t.after(() => component.unmount());
  let writes = 0;
  let props = pickerProps();
  props.onSelect = async (value) => {
    writes++;
    return { selected: value };
  };
  // The cached projection is the old model c and carries the same live marker
  // as the directory request's starting point.
  props = {
    ...props,
    session: {
      ...props.session,
      projections: {
        asOfSeq: 4,
        modelSelectionSeq: 1,
        values: { modelSelection: { lastUsed: model("c") } },
      },
    },
  };
  component.render(props);
  await settle();
  let tree = component.render(props);
  assert.equal(control(tree, "select").props.value, "deepseek\u0000a");
  // A session reload replays the same old history snapshot. Since no live
  // model event marker advanced, the directory remains authoritative.
  props = {
    ...props,
    session: {
      ...props.session,
      projections: {
        asOfSeq: 5,
        modelSelectionSeq: 1,
        values: { modelSelection: { lastUsed: model("c") } },
      },
    },
  };
  tree = component.render(props);
  assert.equal(
    control(tree, "select").props.value,
    "deepseek\u0000a",
    "a snapshot-only projection must not beat a newer directory read",
  );
  control(tree, "select").props.onChange({ target: { value: "deepseek\u0000c" } });
  await settle();
  assert.equal(writes, 1, "choosing the stale displayed model must issue a real request");
  // A live model event (advancing the model watermark) does win.
  props = {
    ...props,
    session: {
      ...props.session,
      projections: {
        asOfSeq: 6,
        modelSelectionSeq: 2,
        values: { modelSelection: { next: model("b") } },
      },
    },
  };
  tree = component.render(props);
  assert.equal(control(tree, "select").props.value, "deepseek\u0000b");
});

test("local receipt stays visible until a new projection and resets after reconnect", async (t) => {
  const component = await picker(async () => directory());
  t.after(() => component.unmount());
  let props = pickerProps();
  component.render(props);
  await settle();
  let tree = component.render(props);
  control(tree, "select").props.onChange({ target: { value: "deepseek\u0000b" } });
  await settle();
  tree = component.render(props);
  assert.equal(control(tree, "select").props.value, "deepseek\u0000b");
  props = {
    ...props,
    session: {
      ...props.session,
      projections: { values: { modelSelection: { lastUsed: model("c") } } },
    },
  };
  tree = component.render(props);
  assert.equal(control(tree, "select").props.value, "deepseek\u0000c");
  props = {
    ...props,
    state: { ...props.state, connections: { dsh: { epoch: 2 } } },
    session: { ...props.session, projections: undefined },
  };
  component.render(props);
  await settle();
  tree = component.render(props);
  assert.equal(control(tree, "select").props.value, "deepseek\u0000a");
});

test("model picker blocks changes while the composer is busy or read-only", async (t) => {
  let writes = 0;
  const component = await picker(async () => directory());
  t.after(() => component.unmount());
  let props = pickerProps();
  props.onSelect = async (value) => {
    writes++;
    return { selected: value };
  };
  component.render(props);
  await settle();
  props = { ...props, busy: true };
  let tree = component.render(props);
  assert.equal(control(tree, "select").props.disabled, true);
  control(tree, "select").props.onChange({ target: { value: "deepseek\u0000b" } });
  props = { ...props, busy: false, session: { ...props.session, readOnly: true } };
  tree = component.render(props);
  assert.equal(control(tree, "select").props.disabled, true);
  control(tree, "select").props.onChange({ target: { value: "deepseek\u0000b" } });
  await settle();
  assert.equal(writes, 0);
});
