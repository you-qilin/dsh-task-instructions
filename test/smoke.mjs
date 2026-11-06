/**
 * 离线自检：不开 DSH、不碰真实 ~/.dsh，用临时 DSH_HOME 跑一遍 host 主链路，
 * 再用假的 window/ModuleLoader 检查 client 是否注册到正确槽位。
 *
 *   node test/smoke.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const home = await mkdtemp(join(tmpdir(), "dsh-task-instructions-"));
process.env.DSH_HOME = home;

const PREFIX = "/dsh-task-instructions/api";
const handlers = new Map();
const listeners = new Map();

const ctx = {
  webServer: {
    register(route) {
      handlers.set(route.path, route.handler);
      return () => handlers.delete(route.path);
    },
  },
  effect(fn) {
    return fn();
  },
  on(event, listener) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(listener);
    return () => {};
  },
};

function call(path, body) {
  return new Promise((resolve, reject) => {
    const handler = handlers.get(PREFIX + String(path).split("?")[0]);
    if (!handler) {
      reject(new Error(`route not registered: ${path}`));
      return;
    }
    const req = new Readable({ read() {} });
    req.method = body === undefined ? "GET" : "POST";
    req.url = PREFIX + path;
    const res = {
      statusCode: 0,
      payload: null,
      writeHead(code) {
        this.statusCode = code;
      },
      end(text) {
        this.payload = JSON.parse(text);
        resolve({ status: this.statusCode, body: this.payload });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
    if (body !== undefined) req.push(JSON.stringify(body));
    req.push(null);
  });
}

const mod = await import("../index.js");
assert.equal(mod.name, "dsh-task-instructions");
assert.deepEqual(mod.inject, ["webServer"]);
mod.apply(ctx);

// ---------------------------------------------------------------- 指令库
const list = await call("/list?sessionId=s-1");
assert.equal(list.status, 200);
assert.equal(list.body.ok, true);
assert.ok(Array.isArray(list.body.value.categories));
assert.ok(list.body.value.categories.length >= 2, "应铺好示例指令");
assert.equal(list.body.value.active, null);

const noteCategory = list.body.value.categories.find((item) => item.name === "写作");
assert.ok(noteCategory, "示例里应有「写作」");
assert.ok(noteCategory.prompts.length >= 2, "写作下应有示例提示词");

// ---------------------------------------------------------------- 激活 + 注入
const prompt = noteCategory.prompts[0];
const activated = await call("/activate", { sessionId: "s-1", categoryId: noteCategory.id, promptId: prompt.id });
assert.equal(activated.status, 200);
assert.equal(activated.body.value.active.promptName, prompt.name);

const listed = await call("/list?sessionId=s-1");
assert.equal(listed.body.value.active.promptId, prompt.id);

const assemble = listeners.get("system-prompt/assemble")?.[0];
assert.equal(typeof assemble, "function");

const baseAssembly = { sections: [{ name: "base", text: "base" }], contexts: [], variables: {} };
const injected = await assemble(baseAssembly, { scope: { id: "s-1" } }, async () => baseAssembly);
const taskSections = injected.sections.filter((section) => section.name === "dsh-task-instructions:active-task-instruction");
assert.equal(taskSections.length, 1, "激活后应注入一段");
assert.match(taskSections[0].text, /TASK>>>/);
assert.ok(taskSections[0].text.includes(prompt.name), "注入文本应带提示词名");

const untouched = await assemble(baseAssembly, { scope: { id: "s-other" } }, async () => baseAssembly);
assert.equal(untouched.sections.length, 1, "别的会话不该被注入");

// 同一会话重复组装不能累加段落
const twice = await assemble(injected, { scope: { id: "s-1" } }, async () => injected);
assert.equal(
  twice.sections.filter((section) => section.name === "dsh-task-instructions:active-task-instruction").length,
  1,
  "重复组装应替换而不是叠加",
);

// ---------------------------------------------------------------- 新建 / 更新 / 删除
const createdCategory = await call("/save-category", { name: "周报" });
assert.equal(createdCategory.status, 200);
const weekly = createdCategory.body.value.categories.find((item) => item.name === "周报");
assert.ok(weekly, "新指令应写入");

const createdPrompt = await call("/save-prompt", {
  categoryId: weekly.id,
  name: "周报模板",
  text: "按 目标 / 进展 / 风险 / 下周计划 四段写。",
});
assert.equal(createdPrompt.status, 200);
const savedWeekly = createdPrompt.body.value.categories.find((item) => item.id === weekly.id);
assert.equal(savedWeekly.prompts.length, 1);

const updatedPrompt = await call("/save-prompt", {
  categoryId: weekly.id,
  promptId: savedWeekly.prompts[0].id,
  name: "周报模板",
  text: "按 目标 / 进展 / 风险 / 下周计划 / 需要的支持 五段写。",
});
assert.equal(updatedPrompt.status, 200);
assert.match(
  updatedPrompt.body.value.categories.find((item) => item.id === weekly.id).prompts[0].text,
  /需要的支持/,
  "更新应覆盖内容",
);

const duplicated = await call("/save-prompt", { categoryId: weekly.id, name: "周报模板", text: "x" });
assert.equal(duplicated.status, 409, "同名提示词应被拒绝");

// ---------------------------------------------------------------- 排序 + 选中后填入输入框
const noteNow = (await call("/list")).body.value.categories.find((item) => item.id === noteCategory.id);
const reversedPromptIds = noteNow.prompts.map((item) => item.id).reverse();
const reorderedPrompts = await call("/reorder", { kind: "prompt", categoryId: noteNow.id, ids: reversedPromptIds });
assert.equal(reorderedPrompts.status, 200);
assert.deepEqual(
  reorderedPrompts.body.value.categories.find((item) => item.id === noteNow.id).prompts.map((item) => item.id),
  reversedPromptIds,
  "提示词应按新顺序落盘",
);

const badPromptOrder = await call("/reorder", { kind: "prompt", categoryId: noteNow.id, ids: [reversedPromptIds[0]] });
assert.equal(badPromptOrder.status, 400, "残缺的顺序应被拒绝");

const reversedCategoryIds = reorderedPrompts.body.value.categories.map((item) => item.id).reverse();
const reorderedCategories = await call("/reorder", { kind: "category", ids: reversedCategoryIds });
assert.equal(reorderedCategories.status, 200);
assert.deepEqual(reorderedCategories.body.value.categories.map((item) => item.id), reversedCategoryIds);

const flaggedCategory = await call("/save-category", { categoryId: noteNow.id, insertIntoDraft: true });
assert.equal(flaggedCategory.status, 200);
assert.equal(
  flaggedCategory.body.value.categories.find((item) => item.id === noteNow.id).insertIntoDraft,
  true,
  "指令级「插入输入框」开关应落盘",
);

const toggledBack = await call("/save-category", {
  categoryId: noteNow.id,
  name: noteNow.name,
  insertIntoDraft: false,
});
assert.equal(
  toggledBack.body.value.categories.find((item) => item.id === noteNow.id).insertIntoDraft,
  false,
);
assert.equal(
  toggledBack.body.value.categories.find((item) => item.id === noteNow.id).name,
  noteNow.name,
  "只切开关时不该改名",
);

const unnamedToggle = await call("/save-category", { categoryId: noteNow.id, insertIntoDraft: true });
assert.equal(unnamedToggle.status, 200, "只传 categoryId 也应能切开关");
assert.equal(
  unnamedToggle.body.value.categories.find((item) => item.id === noteNow.id).name,
  noteNow.name,
);

// 激活后删除提示词：注入自动解除
assert.equal((await call("/activate", { sessionId: "s-2", categoryId: weekly.id, promptId: savedWeekly.prompts[0].id })).status, 200);
assert.equal((await call("/delete-prompt", { categoryId: weekly.id, promptId: savedWeekly.prompts[0].id })).status, 200);
const afterDelete = await assemble(baseAssembly, { scope: { id: "s-2" } }, async () => baseAssembly);
assert.equal(afterDelete.sections.length, 1, "提示词删除后不再注入");

// 停用
assert.equal((await call("/deactivate", { sessionId: "s-1" })).status, 200);
const stopped = await assemble(baseAssembly, { scope: { id: "s-1" } }, async () => baseAssembly);
assert.equal(stopped.sections.length, 1, "停用后不再注入");

// 删除指令
assert.equal((await call("/delete-category", { categoryId: weekly.id })).status, 200);
const finalList = await call("/list?sessionId=s-1");
assert.equal(finalList.body.value.categories.some((item) => item.id === weekly.id), false);

// 落盘了
const stored = JSON.parse(await readFile(join(home, "dsh-task-instructions.json"), "utf8"));
assert.ok(Array.isArray(stored.categories));
const state = JSON.parse(await readFile(join(home, "dsh-task-instructions.state.json"), "utf8"));
assert.equal(state.version, 1);

// ---------------------------------------------------------------- client 注册
const loaded = [];
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded.push(definition);
    },
  },
};
globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => null });

await import("../client.js");
assert.equal(loaded.length, 1);
assert.equal(loaded[0].id, "dsh-task-instructions");

const fakeReact = {
  createElement() {
    return {};
  },
  Fragment: {},
  useState() {
    return [null, () => {}];
  },
  useEffect() {},
  useCallback(fn) {
    return fn;
  },
  useRef() {
    return { current: null };
  },
};
const clientModule = loaded[0].factory((id) => {
  if (id === "react") return fakeReact;
  throw new Error(`unexpected client require: ${id}`);
});

assert.equal(typeof clientModule.apply, "function");
assert.deepEqual(clientModule.inject, ["slots"]);

const registrations = [];
const injectedServices = [];
clientModule.apply({
  slots: {
    inject(key, callback) {
      assert.equal(key, "conversation.input.left");
      callback();
      return () => {};
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
  inject(names, callback) {
    injectedServices.push(...names);
    const scope = {
      sessions: { scope: () => null },
      inputTriggers: {
        registerSource(source) {
          assert.equal(source.name, "task-instruction");
          assert.equal(source.trigger, "@");
          return () => {};
        },
      },
      effect(fn) {
        return fn();
      },
    };
    callback(scope);
    return () => {};
  },
});

assert.deepEqual(injectedServices, ["sessions", "inputTriggers"]);

assert.equal(registrations.length, 1);
assert.equal(registrations[0].options.name, "conversation.input.left");
assert.equal(registrations[0].options.id, "task-instructions");
assert.equal(typeof registrations[0].component, "function");

await rm(home, { recursive: true, force: true });
console.log("smoke ok");
