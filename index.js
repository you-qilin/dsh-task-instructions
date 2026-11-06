/**
 * dsh-task-instructions — host half.
 *
 * 两件事：
 *   1) 维护「任务指令库」：指令（分类，如「笔记」「代码」）→ 提示词（如「阅读笔记」）。
 *      浏览器端通过 /dsh-task-instructions/api/* 读写，落盘到 $DSH_HOME/dsh-task-instructions.json。
 *   2) 会话级激活：某个会话选中的提示词，会在每一轮请求组装 system prompt 时追加一段
 *      <task_instruction>，因此它不占对话气泡、不会被上下文压缩吃掉、也不需要用户重复发送。
 *
 * 说明：注入走 system prompt（而不是改写用户消息），所以：
 *   - 对话记录里只有用户自己写的那句话；
 *   - 每一轮都在，压缩只压缩对话消息、不动 system prompt；
 *   - 文本稳定时位于请求前缀，能被模型侧前缀缓存命中，增量成本很低。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const name = "dsh-task-instructions";

/** 需要 webServer 提供浏览器端 API 路由。 */
const inject = ["webServer"];

// ---------------------------------------------------------------------------
// 存储位置与限制
// ---------------------------------------------------------------------------

const DSH_HOME =
  typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : join(homedir(), ".dsh");

/** 指令库（指令 → 提示词）。 */
const LIBRARY_FILE = join(DSH_HOME, `${name}.json`);
/** 各会话当前激活的提示词。 */
const STATE_FILE = join(DSH_HOME, `${name}.state.json`);

const LIBRARY_VERSION = 1;
const STATE_VERSION = 1;

const MAX_CATEGORIES = 60;
const MAX_PROMPTS = 100;
const MAX_NAME = 60;
const MAX_TEXT = 120_000;
const MAX_ACTIVATIONS = 200;
const MAX_BODY = 1024 * 1024;

/** 注入段在 system prompt 里的唯一名字，用于去重与替换。 */
const SECTION_NAME = `${name}:active-task-instruction`;
const API_PREFIX = `/${name}/api`;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** @param {unknown} value */
function asString(value) {
  return typeof value === "string" ? value : "";
}

/**
 * 原子写：先写临时文件再 rename，避免进程中断留下半截文件。
 * @param {string} file
 * @param {string} text
 */
async function writeAtomic(file, text) {
  await mkdir(DSH_HOME, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

/**
 * 文件损坏时先备份再重置，避免无声丢掉用户写的东西。
 * @param {string} file
 * @param {string} reason
 */
async function quarantine(file, reason) {
  console.warn(`[${name}] ${file} 不可用（${reason}），已备份为 .bak 并重置。`);
  try {
    await rename(file, `${file}.bak`);
  } catch {
    /* 备份失败不阻断，后面会重建 */
  }
}

// ---------------------------------------------------------------------------
// 指令库
// ---------------------------------------------------------------------------

/**
 * 首次使用时的示例内容：三组通用任务，够看出结构，也可以直接改或删。
 * 刻意只放通用格式要求，不含任何个人资料或私有写法。
 */
function defaultLibrary() {
  return {
    version: LIBRARY_VERSION,
    categories: [
      {
        id: randomUUID(),
        name: "写作",
        insertIntoDraft: false,
        prompts: [
          {
            id: randomUUID(),
            name: "结构化摘要",
            text: [
              "把这次要处理的内容整理成结构化摘要，输出 Markdown。",
              "",
              "格式：",
              "1. 一级标题用原文标题，标题下用引用块写来源。",
              "2. 依次输出「一句话结论」「3-5 条要点（每条一行，不超过 40 字）」「关键细节」「待确认的问题」。",
              "3. 要点按重要性排序，不按原文顺序。",
              "4. 原文没写清楚的地方标「未说明」，不要自行补全。",
            ].join("\n"),
          },
          {
            id: randomUUID(),
            name: "修改润色",
            text: [
              "润色下面这段文字，保持原意和信息量不变。",
              "",
              "要求：",
              "1. 先给修改后的全文，再列改了什么（最多 5 条）。",
              "2. 只改表达：去口语、去重复、拆长句；不动事实、数字和结论。",
              "3. 拿不准原意的地方保留原样，并在末尾单独指出。",
            ].join("\n"),
          },
        ],
      },
      {
        id: randomUUID(),
        name: "代码",
        insertIntoDraft: false,
        prompts: [
          {
            id: randomUUID(),
            name: "代码审阅",
            text: [
              "以代码审阅者的身份看这次改动，只评审，不改写整份代码。",
              "",
              "格式：",
              "1. 先给结论：可以合并 / 需要修改 / 必须重写。",
              "2. 按严重程度分组：阻断 / 重要 / 建议；每条带文件与行号。",
              "3. 每个问题写清「为什么是问题」和「最小修法」。",
              "4. 不确定的地方标「待确认」，不要断言。",
            ].join("\n"),
          },
          {
            id: randomUUID(),
            name: "报错排查",
            text: [
              "帮我定位这个报错，按顺序给排查步骤。",
              "",
              "要求：",
              "1. 先用一句话说明最可能的原因。",
              "2. 给 3 条以内可验证的检查，每条写清预期结果。",
              "3. 需要更多信息时，只说需要什么，不要一次给多个大改方案。",
            ].join("\n"),
          },
        ],
      },
      {
        id: randomUUID(),
        name: "会议",
        insertIntoDraft: false,
        prompts: [
          {
            id: randomUUID(),
            name: "会议纪要",
            text: [
              "把会议记录整理成可直接转发的纪要。",
              "",
              "格式：",
              "1. 顶部：时间、参会人、一句话结论。",
              "2. 「讨论要点」：每条一行，写清分歧与共识。",
              "3. 「决定」：只写已经拍板的事。",
              "4. 「行动项」：表格三列——事项 / 负责人 / 截止时间；没有负责人的写「待指派」。",
              "5. 不要补充记录里没有的内容。",
            ].join("\n"),
          },
        ],
      },
    ],
  };
}

/**
 * 把任意输入收敛成合法的指令库结构。
 * @param {unknown} raw
 */
function normalizeLibrary(raw) {
  /** @type {{ id: string, name: string, prompts: { id: string, name: string, text: string }[] }[]} */
  const categories = [];
  const usedCategoryIds = new Set();
  const source = raw && typeof raw === "object" && Array.isArray(raw.categories) ? raw.categories : [];

  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const categoryName = asString(item.name).trim().slice(0, MAX_NAME);
    if (!categoryName) continue;

    let categoryId = asString(item.id).trim() || randomUUID();
    while (usedCategoryIds.has(categoryId)) categoryId = randomUUID();
    usedCategoryIds.add(categoryId);

    /** @type {{ id: string, name: string, text: string }[]} */
    const prompts = [];
    const usedPromptIds = new Set();
    const rawPrompts = Array.isArray(item.prompts) ? item.prompts : [];
    for (const prompt of rawPrompts) {
      if (!prompt || typeof prompt !== "object") continue;
      const promptName = asString(prompt.name).trim().slice(0, MAX_NAME);
      if (!promptName) continue;
      let promptId = asString(prompt.id).trim() || randomUUID();
      while (usedPromptIds.has(promptId)) promptId = randomUUID();
      usedPromptIds.add(promptId);
      prompts.push({
        id: promptId,
        name: promptName,
        text: asString(prompt.text).slice(0, MAX_TEXT),
      });
      if (prompts.length >= MAX_PROMPTS) break;
    }

    categories.push({
      id: categoryId,
      name: categoryName,
      insertIntoDraft: item.insertIntoDraft === true,
      prompts,
    });
    if (categories.length >= MAX_CATEGORIES) break;
  }

  return { version: LIBRARY_VERSION, categories };
}

/** @type {{ stamp: string, library: { version: number, categories: any[] } | null }} */
let libraryCache = { stamp: "", library: null };

/** 读取指令库（按 mtime + size 缓存）。 */
async function loadLibrary() {
  let info;
  try {
    info = await stat(LIBRARY_FILE);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      const seeded = defaultLibrary();
      await saveLibrary(seeded).catch(() => {});
      return seeded;
    }
    throw error;
  }

  const stamp = `${info.mtimeMs}:${info.size}`;
  if (libraryCache.stamp === stamp && libraryCache.library) return libraryCache.library;

  const text = await readFile(LIBRARY_FILE, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    await quarantine(LIBRARY_FILE, `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    const seeded = defaultLibrary();
    await saveLibrary(seeded).catch(() => {});
    return seeded;
  }

  const library = normalizeLibrary(parsed);
  libraryCache = { stamp, library };
  return library;
}

/** @param {{ version: number, categories: any[] }} library */
async function saveLibrary(library) {
  await writeAtomic(LIBRARY_FILE, `${JSON.stringify(library, null, 2)}\n`);
  libraryCache = { stamp: "", library: null };
}

// ---------------------------------------------------------------------------
// 会话激活状态
// ---------------------------------------------------------------------------

/** @type {Map<string, { categoryId: string, promptId: string, activatedAt: string }>} */
let activations = new Map();
/** @type {Promise<void> | null} */
let readyPromise = null;

function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await loadActivations().catch(() => {});
      await loadLibrary().catch(() => {});
    })();
  }
  return readyPromise;
}

async function loadActivations() {
  let text;
  try {
    text = await readFile(STATE_FILE, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    await quarantine(STATE_FILE, `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    activations = new Map();
    await saveActivations().catch(() => {});
    return;
  }

  if (!parsed || parsed.version !== STATE_VERSION) {
    await quarantine(STATE_FILE, `版本 ${parsed && parsed.version} 与当前 ${STATE_VERSION} 不符`);
    activations = new Map();
    await saveActivations().catch(() => {});
    return;
  }

  const sessions = parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {};
  const next = new Map();
  for (const [sessionId, entry] of Object.entries(sessions)) {
    if (!entry || typeof entry !== "object") continue;
    const categoryId = asString(entry.categoryId).trim();
    const promptId = asString(entry.promptId).trim();
    if (!categoryId || !promptId) continue;
    next.set(sessionId, {
      categoryId,
      promptId,
      activatedAt: asString(entry.activatedAt),
    });
  }
  activations = next;
}

async function saveActivations() {
  const entries = [...activations.entries()]
    .sort((left, right) => String(right[1].activatedAt).localeCompare(String(left[1].activatedAt)))
    .slice(0, MAX_ACTIVATIONS);

  /** @type {Record<string, { categoryId: string, promptId: string, activatedAt: string }>} */
  const sessions = {};
  for (const [sessionId, entry] of entries) sessions[sessionId] = entry;

  await writeAtomic(STATE_FILE, `${JSON.stringify({ version: STATE_VERSION, sessions }, null, 2)}\n`);
}

async function activate(sessionId, categoryId, promptId) {
  activations.set(sessionId, { categoryId, promptId, activatedAt: new Date().toISOString() });
  try {
    await saveActivations();
  } catch {
    /* 落盘失败不影响本次注入：内存里已经生效 */
  }
}

async function deactivate(sessionId) {
  activations.delete(sessionId);
  try {
    await saveActivations();
  } catch {
    /* 同上 */
  }
}

/**
 * 把激活记录解析成可注入的内容；指令或提示词已被删除时返回 null。
 * @param {{ categories: any[] }} library
 * @param {string} sessionId
 */
function resolveActive(library, sessionId) {
  const entry = sessionId ? activations.get(sessionId) : undefined;
  if (!entry) return null;

  const category = library.categories.find((candidate) => candidate.id === entry.categoryId);
  if (!category) return null;
  const prompt = category.prompts.find((candidate) => candidate.id === entry.promptId);
  if (!prompt) return null;

  return {
    categoryId: category.id,
    categoryName: category.name,
    promptId: prompt.id,
    promptName: prompt.name,
    text: prompt.text,
  };
}

/**
 * 清理指向已删除指令/提示词的激活记录。
 * @param {{ categories: any[] }} library
 */
function pruneActivations(library) {
  let changed = false;
  for (const [sessionId, entry] of [...activations.entries()]) {
    const category = library.categories.find((candidate) => candidate.id === entry.categoryId);
    const prompt = category ? category.prompts.find((candidate) => candidate.id === entry.promptId) : undefined;
    if (!category || !prompt) {
      activations.delete(sessionId);
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// system prompt 注入
// ---------------------------------------------------------------------------

/**
 * @param {{ categoryName: string, promptName: string, text: string }} active
 */
function renderInstruction(active) {
  const label = `${active.categoryName} / ${active.promptName}`;
  const attribute = JSON.stringify(label);
  // 用户写的内容不能提前闭合包裹块，否则后面的说明会漏到块外。
  const body = String(active.text)
    .replace(/TASK>>>/g, "TASK>>\u005f")
    .replace(/<\/task_instruction>/gi, "<\\/task_instruction>");

  return [
    `<task_instruction name=${attribute} binding="mandatory" scope="session">`,
    "用户在本次会话中为这个任务设定了固定的任务要求。它是常驻指令：每一轮都有效，并且在上下文被压缩之后依然完整保留，用户不需要重复发送。",
    "执行要求：",
    "1. 严格按下面的要求产出：结构、格式、字段、详略与禁止事项都以此为准，不得自行简化或改写格式。",
    "2. 若用户后续的消息与它冲突，先明确指出冲突点，再以本任务要求为准；除非用户明确说要「停用」「切换指令」或改写这些要求。",
    "3. 不要复述、解释或讨论这段要求本身，直接按它工作。",
    "",
    "任务要求原文：",
    "<<<TASK",
    body,
    "TASK>>>",
    "</task_instruction>",
  ].join("\n");
}

/**
 * system-prompt/assemble：把当前会话激活的提示词追加进 system prompt。
 * @param {{ sections: { name: string, text: string }[] }} assembly
 * @param {{ scope?: any } | undefined} context
 * @param {() => Promise<any>} next
 */
async function onAssemble(assembly, context, next) {
  const result = await next();
  if (!result || !Array.isArray(result.sections)) return result;

  const scope = context && context.scope;
  const sessionId = scope && (typeof scope.id === "string" ? scope.id : typeof scope.sessionId === "string" ? scope.sessionId : "");
  if (!sessionId) return result;

  await ready();
  if (!activations.has(sessionId)) return result;

  let library;
  try {
    library = await loadLibrary();
  } catch {
    return result;
  }

  const active = resolveActive(library, sessionId);
  if (!active) {
    // 提示词已被删除：静默解除激活，避免一直注入不存在的内容。
    await deactivate(sessionId);
    return result;
  }

  const sections = result.sections.filter((section) => !section || section.name !== SECTION_NAME);
  sections.push({ name: SECTION_NAME, text: renderInstruction(active) });
  return { ...result, sections };
}

// ---------------------------------------------------------------------------
// HTTP 辅助
// ---------------------------------------------------------------------------

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

/** @param {import("node:http").ServerResponse} res */
function ok(res, value) {
  sendJson(res, 200, { ok: true, value });
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
function fail(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * 从查询串里取 sessionId。
 * @param {import("node:http").IncomingMessage} req
 */
function querySession(req) {
  try {
    const url = new URL(String((req && req.url) || "/"), "http://localhost");
    return url.searchParams.get("sessionId") || "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * @param {any} ctx
 */
function apply(ctx) {
  void ready();

  /**
   * @param {string} path
   * @param {(req: any, res: any) => Promise<void> | void} handler
   */
  const register = (path, handler) =>
    ctx.effect(() => ctx.webServer.register({ kind: "exact", path: `${API_PREFIX}${path}`, handler }), `${name}: ${path}`);

  /** @param {any} req @param {any} res */
  const requirePost = (req, res) => {
    if (req.method === "POST") return true;
    fail(res, 405, "method-error", "method not allowed");
    return false;
  };

  // 指令库 + 当前会话的激活状态
  register("/list", async (req, res) => {
    try {
      await ready();
      const library = await loadLibrary();
      const sessionId = querySession(req);
      const active = resolveActive(library, sessionId);
      const value = {
        file: LIBRARY_FILE,
        categories: library.categories,
        active: active
          ? { categoryId: active.categoryId, categoryName: active.categoryName, promptId: active.promptId, promptName: active.promptName }
          : null,
      };
      ok(res, value);
    } catch (error) {
      fail(res, 500, "read-failed", String((error && error.message) || error));
    }
  });

  // 激活某个提示词（会话级，持续到被替换或停用）
  register("/activate", async (req, res) => {
    if (!requirePost(req, res)) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      fail(res, 400, "bad-request", String((error && error.message) || error));
      return;
    }

    const sessionId = asString(body && body.sessionId).trim();
    const categoryId = asString(body && body.categoryId).trim();
    const promptId = asString(body && body.promptId).trim();
    if (!sessionId) {
      fail(res, 400, "bad-request", "缺少 sessionId");
      return;
    }

    try {
      await ready();
      const library = await loadLibrary();
      const category = library.categories.find((candidate) => candidate.id === categoryId);
      const prompt = category ? category.prompts.find((candidate) => candidate.id === promptId) : undefined;
      if (!category || !prompt) {
        fail(res, 404, "no-such-prompt", "这条提示词已不存在");
        return;
      }
      await activate(sessionId, category.id, prompt.id);
      ok(res, {
        active: { categoryId: category.id, categoryName: category.name, promptId: prompt.id, promptName: prompt.name },
      });
    } catch (error) {
      fail(res, 500, "write-failed", String((error && error.message) || error));
    }
  });

  // 停用当前会话的任务指令
  register("/deactivate", async (req, res) => {
    if (!requirePost(req, res)) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      fail(res, 400, "bad-request", String((error && error.message) || error));
      return;
    }
    const sessionId = asString(body && body.sessionId).trim();
    if (!sessionId) {
      fail(res, 400, "bad-request", "缺少 sessionId");
      return;
    }
    try {
      await deactivate(sessionId);
      ok(res, { active: null });
    } catch (error) {
      fail(res, 500, "write-failed", String((error && error.message) || error));
    }
  });

  // 新建 / 重命名指令（分类）
  register("/save-category", async (req, res) => {
    if (!requirePost(req, res)) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      fail(res, 400, "bad-request", String((error && error.message) || error));
      return;
    }

    const categoryId = asString(body && body.categoryId).trim();
    const categoryName = asString(body && body.name).trim();
    const insertIntoDraft = Boolean(body && body.insertIntoDraft);

    // 只切换开关时允许不传名称（沿用原名）
    if (!categoryName && !categoryId) {
      fail(res, 400, "bad-request", "指令名称不能为空");
      return;
    }
    if (categoryName.length > MAX_NAME) {
      fail(res, 400, "bad-request", `指令名称不能超过 ${MAX_NAME} 个字符`);
      return;
    }

    try {
      await ready();
      const library = await loadLibrary();
      const clash = categoryName
        ? library.categories.find((candidate) => candidate.name === categoryName && candidate.id !== categoryId)
        : undefined;
      if (clash) {
        fail(res, 409, "duplicate-name", `已存在同名指令「${categoryName}」`);
        return;
      }

      if (categoryId) {
        const category = library.categories.find((candidate) => candidate.id === categoryId);
        if (!category) {
          fail(res, 404, "not-found", "这条指令已不存在");
          return;
        }
        if (categoryName) category.name = categoryName;
        if (body && typeof body === "object" && "insertIntoDraft" in body) {
          category.insertIntoDraft = insertIntoDraft;
        }
      } else {
        if (library.categories.length >= MAX_CATEGORIES) {
          fail(res, 400, "too-many", `最多 ${MAX_CATEGORIES} 条指令`);
          return;
        }
        library.categories.push({
          id: randomUUID(),
          name: categoryName,
          insertIntoDraft,
          prompts: [],
        });
      }

      await saveLibrary(library);
      ok(res, { file: LIBRARY_FILE, categories: library.categories });
    } catch (error) {
      fail(res, 500, "write-failed", String((error && error.message) || error));
    }
  });

  // 删除指令（分类）及其下所有提示词
  register("/delete-category", async (req, res) => {
    if (!requirePost(req, res)) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      fail(res, 400, "bad-request", String((error && error.message) || error));
      return;
    }
    const categoryId = asString(body && body.categoryId).trim();
    if (!categoryId) {
      fail(res, 400, "bad-request", "缺少 categoryId");
      return;
    }

    try {
      await ready();
      const library = await loadLibrary();
      const next = library.categories.filter((candidate) => candidate.id !== categoryId);
      if (next.length === library.categories.length) {
        fail(res, 404, "not-found", "这条指令已不存在");
        return;
      }
      library.categories = next;
      await saveLibrary(library);
      if (pruneActivations(library)) await saveActivations().catch(() => {});
      ok(res, { file: LIBRARY_FILE, categories: library.categories });
    } catch (error) {
      fail(res, 500, "write-failed", String((error && error.message) || error));
    }
  });

  // 新建 / 更新提示词
  register("/save-prompt", async (req, res) => {
    if (!requirePost(req, res)) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      fail(res, 400, "bad-request", String((error && error.message) || error));
      return;
    }

    const categoryId = asString(body && body.categoryId).trim();
    const promptId = asString(body && body.promptId).trim();
    const promptName = asString(body && body.name).trim();
    const text = asString(body && body.text);

    if (!categoryId) {
      fail(res, 400, "bad-request", "缺少 categoryId");
      return;
    }
    if (!promptName) {
      fail(res, 400, "bad-request", "提示词名称不能为空");
      return;
    }
    if (promptName.length > MAX_NAME) {
      fail(res, 400, "bad-request", `提示词名称不能超过 ${MAX_NAME} 个字符`);
      return;
    }
    if (text.length > MAX_TEXT) {
      fail(res, 400, "bad-request", "提示词内容过长");
      return;
    }

    try {
      await ready();
      const library = await loadLibrary();
      const category = library.categories.find((candidate) => candidate.id === categoryId);
      if (!category) {
        fail(res, 404, "not-found", "这条指令已不存在");
        return;
      }

      const clash = category.prompts.find((candidate) => candidate.name === promptName && candidate.id !== promptId);
      if (clash) {
        fail(res, 409, "duplicate-name", `「${category.name}」下已有同名提示词「${promptName}」`);
        return;
      }

      if (promptId) {
        const prompt = category.prompts.find((candidate) => candidate.id === promptId);
        if (!prompt) {
          fail(res, 404, "not-found", "这条提示词已不存在");
          return;
        }
        prompt.name = promptName;
        prompt.text = text;
      } else {
        if (category.prompts.length >= MAX_PROMPTS) {
          fail(res, 400, "too-many", `每条指令最多 ${MAX_PROMPTS} 个提示词`);
          return;
        }
        category.prompts.push({ id: randomUUID(), name: promptName, text });
      }

      await saveLibrary(library);
      ok(res, { file: LIBRARY_FILE, categories: library.categories });
    } catch (error) {
      fail(res, 500, "write-failed", String((error && error.message) || error));
    }
  });

  // 调整顺序（面板里拖动排序）
  register("/reorder", async (req, res) => {
    if (!requirePost(req, res)) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      fail(res, 400, "bad-request", String((error && error.message) || error));
      return;
    }

    const kind = asString(body && body.kind);
    const ids = Array.isArray(body && body.ids)
      ? body.ids.map((id) => asString(id).trim()).filter(Boolean)
      : [];

    /**
     * 用新顺序重排；id 集合与原来不一致时返回 null。
     * @param {any[]} list
     */
    const reorder = (list) => {
      if (ids.length !== list.length || new Set(ids).size !== ids.length) return null;
      const byId = new Map(list.map((item) => [item.id, item]));
      const next = [];
      for (const id of ids) {
        const item = byId.get(id);
        if (!item) return null;
        next.push(item);
      }
      return next;
    };

    try {
      await ready();
      const library = await loadLibrary();

      if (kind === "category") {
        const next = reorder(library.categories);
        if (!next) {
          fail(res, 400, "bad-order", "顺序与现有指令不一致");
          return;
        }
        library.categories = next;
      } else if (kind === "prompt") {
        const categoryId = asString(body && body.categoryId).trim();
        const category = library.categories.find((candidate) => candidate.id === categoryId);
        if (!category) {
          fail(res, 404, "not-found", "这条指令已不存在");
          return;
        }
        const next = reorder(category.prompts);
        if (!next) {
          fail(res, 400, "bad-order", "顺序与现有提示词不一致");
          return;
        }
        category.prompts = next;
      } else {
        fail(res, 400, "bad-request", "kind 必须是 category 或 prompt");
        return;
      }

      await saveLibrary(library);
      ok(res, { file: LIBRARY_FILE, categories: library.categories });
    } catch (error) {
      fail(res, 500, "write-failed", String((error && error.message) || error));
    }
  });

  // 删除提示词
  register("/delete-prompt", async (req, res) => {
    if (!requirePost(req, res)) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      fail(res, 400, "bad-request", String((error && error.message) || error));
      return;
    }

    const categoryId = asString(body && body.categoryId).trim();
    const promptId = asString(body && body.promptId).trim();
    if (!categoryId || !promptId) {
      fail(res, 400, "bad-request", "缺少 categoryId 或 promptId");
      return;
    }

    try {
      await ready();
      const library = await loadLibrary();
      const category = library.categories.find((candidate) => candidate.id === categoryId);
      if (!category) {
        fail(res, 404, "not-found", "这条指令已不存在");
        return;
      }
      const before = category.prompts.length;
      category.prompts = category.prompts.filter((candidate) => candidate.id !== promptId);
      if (category.prompts.length === before) {
        fail(res, 404, "not-found", "这条提示词已不存在");
        return;
      }
      await saveLibrary(library);
      if (pruneActivations(library)) await saveActivations().catch(() => {});
      ok(res, { file: LIBRARY_FILE, categories: library.categories });
    } catch (error) {
      fail(res, 500, "write-failed", String((error && error.message) || error));
    }
  });

  ctx.on("system-prompt/assemble", onAssemble);
}

export { apply, inject, name };
