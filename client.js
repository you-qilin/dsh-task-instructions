/**
 * dsh-task-instructions — client half.
 *
 * 在输入框左侧工具行挂一个「任务指令」按钮：
 *   点开 → 选指令（笔记 / 代码 / …）→ 选提示词（提示词1 / 提示词2 / …）
 *   选中后该提示词就成为这个会话的常驻任务要求；「新建指令」「新建提示词」可以直接在面板里填写并保存。
 *
 * 面板只负责编辑与选择；真正的注入在 host 端（system prompt，见 index.js）。
 */
window.__ModuleLoader__.load({
  id: "dsh-task-instructions",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    /** react-dom 的 portal：浮层要挂到 body 上，才不会被输入框卡片裁掉。 */
    let createPortal = null;
    try {
      const reactDom = require("react-dom");
      if (reactDom && typeof reactDom.createPortal === "function") createPortal = reactDom.createPortal;
    } catch (error) {
      createPortal = null;
    }

    // ---------------------------------------------------------------- 样式
    const STYLE_ID = "dsh-task-instructions-style";
    const CSS = `
.ti-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.26));background:transparent;
  color:var(--dsw-alias-label-secondary,#6b7280);font:inherit;font-size:12px;line-height:1;cursor:pointer;
  white-space:nowrap;transition:background .12s,color .12s,border-color .12s}
.ti-btn:hover{background:rgba(128,128,128,.12);color:var(--dsw-alias-label-primary,#1f2329)}
.ti-btn[data-active="true"]{color:var(--dsw-alias-brand-primary,#4d6bfe);border-color:var(--dsw-alias-brand-primary,#4d6bfe);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 12%,transparent)}
.ti-btn-text{max-width:11em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ti-caret{font-size:9px;opacity:.6}

.ti-popover{position:fixed;z-index:2147483000;display:flex;flex-direction:column;box-sizing:border-box;
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  color:var(--dsw-alias-label-primary,#1f2329);
  background:var(--dsw-alias-bg-overlay,rgba(255,255,255,.97));
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));
  border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.22);overflow:hidden;animation:ti-pop .12s ease-out}
@keyframes ti-pop{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.ti-head{flex:0 0 auto;display:flex;align-items:baseline;justify-content:space-between;gap:10px;
  padding:10px 12px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}
.ti-title{font-size:12.5px;font-weight:650;letter-spacing:.01em}
.ti-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280)}
.ti-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px}
.ti-row{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:8px 9px;
  border:0;border-radius:9px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.ti-row:hover{background:rgba(128,128,128,.13)}
.ti-row-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:550}
.ti-row-meta{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280)}
.ti-chevron{flex:0 0 auto;color:var(--dsw-alias-label-secondary,#6b7280);opacity:.7}
.ti-row-add{color:var(--dsw-alias-brand-primary,#4d6bfe)}
.ti-row-danger{color:var(--dsw-alias-state-error-primary,#d33)}
.ti-row[data-dragging="true"],.ti-prompt[data-dragging="true"]{opacity:.45}
.ti-row[data-drop="true"],.ti-prompt[data-drop="true"]{box-shadow:inset 0 2px 0 var(--dsw-alias-brand-primary,#4d6bfe)}
.ti-rename{flex:1 1 auto;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-brand-primary,#4d6bfe);
  border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));color:inherit;
  font:inherit;font-size:12.5px;font-weight:550;padding:3px 6px;outline:none}
.ti-divider{height:1px;margin:5px 4px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.2))}

.ti-active{display:flex;align-items:center;gap:7px;margin:2px 2px 6px;padding:8px 9px;border-radius:9px;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 9%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 32%,transparent)}
.ti-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4d6bfe);flex:0 0 auto}
.ti-active-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:550}
.ti-link{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font:inherit;
  font-size:11.5px;cursor:pointer;padding:2px 5px;border-radius:5px}
.ti-link:hover{color:var(--dsw-alias-state-error-primary,#d33);background:rgba(128,128,128,.12)}

.ti-prompt{display:flex;align-items:center;gap:4px;border-radius:9px}
.ti-prompt:hover{background:rgba(128,128,128,.13)}
.ti-prompt[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 9%,transparent)}
.ti-prompt-main{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px;padding:8px 4px 8px 9px;
  border:0;border-radius:9px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.ti-badge{flex:0 0 auto;font-size:10px;padding:1px 6px;border-radius:999px;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 18%,transparent);
  color:var(--dsw-alias-brand-primary,#4d6bfe)}
.ti-icon-btn{flex:0 0 auto;width:26px;height:26px;margin-right:4px;border:0;border-radius:7px;background:transparent;
  color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;font-size:12px;opacity:.5;
  transition:opacity .12s,background .12s}
.ti-prompt:hover .ti-icon-btn,.ti-icon-btn:focus-visible{opacity:1}
.ti-icon-btn:hover{background:rgba(128,128,128,.18);color:var(--dsw-alias-label-primary,#1f2329)}

.ti-back{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;margin-bottom:2px;
  border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);
  font:inherit;font-size:12px;cursor:pointer;text-align:left}
.ti-back:hover{background:rgba(128,128,128,.12);color:var(--dsw-alias-label-primary,#1f2329)}
.ti-back-arrow{font-size:15px;line-height:1}
.ti-back-text{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.ti-form{display:flex;flex-direction:column;gap:6px;padding:4px 3px 3px}
.ti-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);margin-top:3px}
.ti-input,.ti-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.34));
  border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));color:inherit;font:inherit;
  font-size:12.5px;padding:7px 9px;outline:none}
.ti-input:focus,.ti-textarea:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.ti-textarea{min-height:150px;max-height:260px;resize:vertical;
  font-family:ui-monospace,SFMono-Regular,Consolas,"Microsoft YaHei",monospace;font-size:12px;line-height:1.65}
.ti-actions{display:flex;align-items:center;gap:8px;margin-top:6px}
.ti-primary,.ti-plain,.ti-danger{appearance:none;border:1px solid transparent;border-radius:8px;
  font:inherit;font-size:12px;padding:6px 12px;cursor:pointer}
.ti-primary{background:transparent;border-color:currentColor;
  color:var(--dsw-alias-state-success-primary,#3fa45b)}
.ti-primary:hover{background:rgba(128,128,128,.14)}
.ti-primary:disabled{opacity:.45;cursor:not-allowed}
.ti-plain{border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.45));background:transparent;
  color:var(--dsw-alias-label-primary,#1f2329)}
.ti-plain:hover{background:rgba(128,128,128,.14)}
.ti-danger{background:transparent;border-color:currentColor;
  color:var(--dsw-alias-state-error-primary,#d13438)}
.ti-danger:hover{background:rgba(128,128,128,.14)}
.ti-danger:disabled{opacity:.45;cursor:not-allowed}
.ti-check{display:flex;align-items:center;gap:7px;margin-top:4px;font-size:11.5px;cursor:pointer;
  color:var(--dsw-alias-label-secondary,#6b7280)}
.ti-check input{accent-color:var(--dsw-alias-brand-primary,#4d6bfe);margin:0}
.ti-error{flex:0 0 auto;padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));
  color:var(--dsw-alias-state-error-primary,#d33);font-size:11.5px;line-height:1.5}
.ti-empty{margin:0;padding:14px 10px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;
  text-align:center;line-height:1.6}
`;

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID)) return;
      const tag = document.createElement("style");
      tag.id = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ---------------------------------------------------------------- HTTP
    const API = "/dsh-task-instructions/api";

    /**
     * @param {string} path
     * @param {unknown} [body]
     */
    async function callApi(path, body) {
      const init =
        body === undefined
          ? { method: "GET" }
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            };

      const response = await fetch(API + path, init);
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const message =
          payload && payload.error && payload.error.message
            ? String(payload.error.message)
            : `请求失败（HTTP ${response.status}）`;
        throw new Error(message);
      }
      return payload.value;
    }

    /** @param {unknown} reason */
    function messageOf(reason) {
      if (reason && typeof reason.message === "string" && reason.message) return reason.message;
      return String(reason);
    }

    /** @param {string} value @param {number} max */
    function clip(value, max) {
      const text = String(value || "");
      return text.length > max ? `${text.slice(0, max)}…` : text;
    }

    /** @param {string} text */
    function promptPreview(text) {
      const line = String(text || "")
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && !item.startsWith("<<<") && !item.startsWith("TASK"))
        .slice(0, 3)
        .join(" ");
      return clip(line, 180);
    }

    // ------------------------------------------------------- 指令型 chip
    /** 注册到 inputTriggers 的 source 名；输入机器按它把 chip 路由回本插件做序列化。 */
    const INSTRUCTION_SOURCE = "task-instruction";
    /** sessions 服务（apply 时捕获）：按 sessionId 解析 session scope 才能派发输入事件。 */
    let sessionsRef = null;

    /** 只做序列化，不提供 @ 候选菜单。 */
    const instructionSource = {
      trigger: "@",
      name: INSTRUCTION_SOURCE,
      order: 910,
      showGroupTitle: false,
      candidates: async () => [],
      onPick: () => undefined,
      codec: {
        clipboardText: (ref) => String(ref),
        serialize: async (ref) => String(ref),
      },
    };

    function TaskIcon() {
      return h(
        "svg",
        { viewBox: "0 0 16 16", width: 13, height: 13, "aria-hidden": "true", focusable: "false", style: { display: "block" } },
        h("path", {
          d: "M5.1 2.6h5.8c.9 0 1.6.7 1.6 1.6v8.2c0 .9-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.7-1.6-1.6V4.2c0-.9.7-1.6 1.6-1.6Z",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.3,
        }),
        h("path", { d: "M6.2 1.3h3.6v1.7H6.2z", fill: "currentColor", opacity: 0.85 }),
        h("path", {
          d: "M5.7 8.5l1.4 1.4 3-3.1",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.4,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );
    }

    // ------------------------------------------------------------ 按钮本体
    /**
     * @param {any} props conversation.input.left 的 standard props（sessionId 等）
     */
    function TaskInstructionButton(props) {
      const sessionId = String((props && (props.sessionId || props.sessionKey)) || "");

      const [open, setOpen] = useState(false);
      const [library, setLibrary] = useState(null);
      const [active, setActive] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [view, setView] = useState({ kind: "menu" });
      const [draft, setDraft] = useState({ name: "", text: "", insertIntoDraft: false });
      const [renaming, setRenaming] = useState(null);
      const [dragging, setDragging] = useState(null);
      const [dropTarget, setDropTarget] = useState(null);
      const [anchor, setAnchor] = useState({ left: 40, top: 240 });

      const buttonRef = useRef(null);
      const panelRef = useRef(null);
      const clickTimer = useRef(null);

      const refresh = useCallback(async () => {
        const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
        const value = await callApi(`/list${query}`);
        setLibrary(Array.isArray(value.categories) ? value.categories : []);
        setActive(value.active || null);
      }, [sessionId]);

      useEffect(() => {
        let alive = true;
        refresh().catch((reason) => {
          if (alive) setError(messageOf(reason));
        });
        return () => {
          alive = false;
        };
      }, [refresh]);

      // 单击延迟 190ms：双击名字改名时不该先触发一次「打开 / 激活」
      const cancelPendingClick = () => {
        if (clickTimer.current) {
          clearTimeout(clickTimer.current);
          clickTimer.current = null;
        }
      };
      /** @param {() => void} action */
      const later = (action) => {
        cancelPendingClick();
        clickTimer.current = setTimeout(() => {
          clickTimer.current = null;
          action();
        }, 190);
      };
      useEffect(() => () => cancelPendingClick(), []);

      /** 把 fromId 挪到 toId 的位置；顺序没变时返回 null。@returns {any[] | null} */
      const movedList = (list, fromId, toId) => {
        const ids = list.map((item) => item.id);
        const from = ids.indexOf(fromId);
        const to = ids.indexOf(toId);
        if (from < 0 || to < 0 || from === to) return null;
        const next = list.slice();
        next.splice(to, 0, next.splice(from, 1)[0]);
        return next;
      };

      /** @param {any[]} next */
      const saveCategoryOrder = async (next) => {
        setLibrary(next);
        try {
          const value = await callApi("/reorder", { kind: "category", ids: next.map((item) => item.id) });
          setLibrary(Array.isArray(value.categories) ? value.categories : next);
        } catch (reason) {
          setError(messageOf(reason));
          refresh().catch(() => {});
        }
      };

      /** @param {string} categoryId @param {any[]} next */
      const savePromptOrder = async (categoryId, next) => {
        setLibrary((previous) =>
          (previous || []).map((category) => (category.id === categoryId ? { ...category, prompts: next } : category)),
        );
        try {
          const value = await callApi("/reorder", { kind: "prompt", categoryId, ids: next.map((item) => item.id) });
          if (Array.isArray(value.categories)) setLibrary(value.categories);
        } catch (reason) {
          setError(messageOf(reason));
          refresh().catch(() => {});
        }
      };

      /** @param {"category" | "prompt"} kind @param {any} item */
      const startRename = (kind, item) => {
        cancelPendingClick();
        setError(null);
        setRenaming({ kind, id: item.id, value: item.name, original: item.name });
      };

      const commitRename = async () => {
        const target = renaming;
        if (!target) return;
        const value = String(target.value || "").trim();
        setRenaming(null);
        if (!value || value === target.original) return;

        setBusy(true);
        setError(null);
        try {
          if (target.kind === "category") {
            await callApi("/save-category", { categoryId: target.id, name: value });
          } else {
            let owner = null;
            for (const category of library || []) {
              const prompt = category.prompts.find((item) => item.id === target.id);
              if (prompt) {
                owner = { category, prompt };
                break;
              }
            }
            if (!owner) return;
            await callApi("/save-prompt", {
              categoryId: owner.category.id,
              promptId: owner.prompt.id,
              name: value,
              text: owner.prompt.text || "",
            });
          }
          await refresh();
        } catch (reason) {
          setError(messageOf(reason));
        } finally {
          setBusy(false);
        }
      };

      // 打开时：只有点面板外面、按 Esc 或窗口尺寸变化才收起；滚动只让面板跟着按钮走
      useEffect(() => {
        if (!open) return undefined;

        /** @param {Event} event */
        const onPointerDown = (event) => {
          const target = event.target;
          if (!(target instanceof Node)) return;
          if (panelRef.current && panelRef.current.contains(target)) return;
          if (buttonRef.current && buttonRef.current.contains(target)) return;
          setOpen(false);
        };
        /** @param {KeyboardEvent} event */
        const onKeyDown = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        const syncAnchor = () => {
          const rect = buttonRef.current ? buttonRef.current.getBoundingClientRect() : null;
          if (!rect) return;
          setAnchor((previous) =>
            previous.left === rect.left && previous.top === rect.top
              ? previous
              : { left: rect.left, top: rect.top },
          );
        };
        /** @param {Event} event */
        const onScroll = (event) => {
          const target = event.target;
          // 面板内部（提示词列表、任务要求输入框）用滚轮滚动时不该动面板，更不该把面板关掉
          if (panelRef.current && target instanceof Node && panelRef.current.contains(target)) return;
          syncAnchor();
        };
        const onResize = () => setOpen(false);

        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("resize", onResize);
        window.addEventListener("scroll", onScroll, true);
        return () => {
          document.removeEventListener("pointerdown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown, true);
          window.removeEventListener("resize", onResize);
          window.removeEventListener("scroll", onScroll, true);
          cancelPendingClick();
        };
      }, [open]);

      const openPanel = () => {
        const rect = buttonRef.current ? buttonRef.current.getBoundingClientRect() : null;
        setAnchor(rect ? { left: rect.left, top: rect.top } : { left: 40, top: 240 });
        setView({ kind: "menu" });
        setError(null);
        setOpen(true);
        refresh().catch((reason) => setError(messageOf(reason)));
      };

      /** 当前草稿（没有 useInput 时为空串） */
      const draftText = (() => {
        try {
          return typeof props.useInput === "function"
            ? String(props.useInput((state) => (state && state.draft) || "") || "")
            : "";
        } catch (error) {
          return "";
        }
      })();

      /**
       * 把「指令型」任务指令插成一枚 chip；失败时退回纯文本。
       * @param {string} label 显示名
       * @param {string} sentence 提交时序列化出来的正文
       */
      const insertInstructionChip = (label, sentence) => {
        const actions = props && props.inputActions;
        if (!actions) return false;

        let span = null;
        try {
          if (typeof actions.captureInsertion === "function") span = actions.captureInsertion();
        } catch (error) {
          span = null;
        }

        if (span && Number.isFinite(span.draftRev)) {
          try {
            const actx = sessionsRef && typeof sessionsRef.scope === "function" ? sessionsRef.scope(sessionId) : null;
            if (actx && typeof actx.bail === "function") {
              const inserted =
                actx.bail("slash/input-insert-reference", {
                  reference: {
                    source: INSTRUCTION_SOURCE,
                    ref: sentence,
                    label,
                    appearance: "file",
                    clipboardText: sentence,
                  },
                  span,
                }) === true;
              if (inserted) {
                if (typeof actions.focus === "function") actions.focus();
                return true;
              }
            }
          } catch (error) {
            /* 插 chip 失败就退回纯文本 */
          }
        }

        if (typeof actions.setDraft === "function") {
          try {
            actions.setDraft(draftText ? `${draftText}\n${sentence}` : sentence);
            if (typeof actions.focus === "function") actions.focus();
            return true;
          } catch (error) {
            return false;
          }
        }
        return false;
      };

      /** @param {any} category @param {any} prompt */
      const usePrompt = async (category, prompt) => {
        if (!sessionId) {
          setError("当前会话还不可用（缺少 sessionId），暂时不能激活。");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          const value = await callApi("/activate", { sessionId, categoryId: category.id, promptId: prompt.id });
          setActive(value.active || null);
          setOpen(false);
          if (category.insertIntoDraft) {
            const sentence = `请按任务指令「${category.name} / ${prompt.name}」的要求直接产出结果。`;
            insertInstructionChip(prompt.name, sentence);
          }
        } catch (reason) {
          setError(messageOf(reason));
        } finally {
          setBusy(false);
        }
      };

      const stopActive = async () => {
        if (!sessionId) return;
        setBusy(true);
        setError(null);
        try {
          await callApi("/deactivate", { sessionId });
          setActive(null);
        } catch (reason) {
          setError(messageOf(reason));
        } finally {
          setBusy(false);
        }
      };

      const startNewCategory = () => {
        setError(null);
        setRenaming(null);
        setDraft({ name: "", text: "", insertIntoDraft: false });
        setView({ kind: "editCategory", categoryId: "" });
      };

      /** @param {string} categoryId */
      const startNewPrompt = (categoryId) => {
        setError(null);
        setRenaming(null);
        setDraft({ name: "", text: "", insertIntoDraft: false });
        setView({ kind: "editPrompt", categoryId, promptId: "" });
      };

      /** @param {string} categoryId @param {any} prompt */
      const startEditPrompt = (categoryId, prompt) => {
        setError(null);
        setRenaming(null);
        setDraft({ name: prompt.name, text: prompt.text || "", insertIntoDraft: false });
        setView({ kind: "editPrompt", categoryId, promptId: prompt.id });
      };

      const saveCategory = async () => {
        const categoryName = draft.name.trim();
        if (!categoryName) {
          setError("请先填写指令名称，例如「笔记」。");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          await callApi("/save-category", {
            categoryId: view.categoryId || "",
            name: categoryName,
            insertIntoDraft: Boolean(draft.insertIntoDraft),
          });
          await refresh();
          setView({ kind: "menu" });
        } catch (reason) {
          setError(messageOf(reason));
        } finally {
          setBusy(false);
        }
      };

      /** 切换「选中后插入输入框」（指令级开关） @param {any} category */
      const toggleInsertIntoDraft = async (category) => {
        setBusy(true);
        setError(null);
        try {
          await callApi("/save-category", {
            categoryId: category.id,
            name: category.name,
            insertIntoDraft: !category.insertIntoDraft,
          });
          await refresh();
        } catch (reason) {
          setError(messageOf(reason));
        } finally {
          setBusy(false);
        }
      };

      /** @param {any} category */
      const removeCategory = async (category) => {
        const confirmed =
          typeof window.confirm === "function"
            ? window.confirm(`删除指令「${category.name}」？它下面的提示词会一起删除。`)
            : true;
        if (!confirmed) return;
        setBusy(true);
        setError(null);
        try {
          await callApi("/delete-category", { categoryId: category.id });
          await refresh();
          setView({ kind: "menu" });
        } catch (reason) {
          setError(messageOf(reason));
        } finally {
          setBusy(false);
        }
      };

      const savePrompt = async () => {
        const promptName = draft.name.trim();
        if (!promptName) {
          setError("请先填写提示词名称，例如「阅读笔记」。");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          await callApi("/save-prompt", {
            categoryId: view.categoryId,
            promptId: view.promptId || "",
            name: promptName,
            text: draft.text,
          });
          await refresh();
          setView({ kind: "prompts", categoryId: view.categoryId });
        } catch (reason) {
          setError(messageOf(reason));
        } finally {
          setBusy(false);
        }
      };

      const removePrompt = async () => {
        const confirmed = typeof window.confirm === "function" ? window.confirm("删除这条提示词？") : true;
        if (!confirmed) return;
        setBusy(true);
        setError(null);
        try {
          await callApi("/delete-prompt", { categoryId: view.categoryId, promptId: view.promptId });
          await refresh();
          setView({ kind: "prompts", categoryId: view.categoryId });
        } catch (reason) {
          setError(messageOf(reason));
        } finally {
          setBusy(false);
        }
      };

      // ------------------------------------------------------------ 视图
      /** @param {string} title @param {() => void} onClick */
      const backRow = (title, onClick) =>
        h(
          "button",
          { type: "button", className: "ti-back", onClick },
          h("span", { className: "ti-back-arrow", "aria-hidden": "true" }, "‹"),
          h("span", { className: "ti-back-text", title }, title),
        );

      const renderMenu = () => {
        const rows = [];

        if (active) {
          rows.push(
            h(
              "div",
              { className: "ti-active", key: "__active" },
              h("span", { className: "ti-dot", "aria-hidden": "true" }),
              h("span", { className: "ti-active-text", title: `${active.categoryName} / ${active.promptName}` },
                `${active.categoryName} / ${active.promptName}`),
              h("button", { type: "button", className: "ti-link", onClick: stopActive, disabled: busy }, "停用"),
            ),
          );
        }

        const categories = library || [];
        if (library === null && !error) {
          rows.push(h("p", { className: "ti-empty", key: "__loading" }, "读取任务指令…"));
        }
        for (const category of categories) {
          const editingThis = Boolean(renaming && renaming.kind === "category" && renaming.id === category.id);
          const dragProps = {
            draggable: !editingThis,
            "data-dragging": dragging && dragging.kind === "category" && dragging.id === category.id ? "true" : "false",
            "data-drop": dropTarget && dropTarget.kind === "category" && dropTarget.id === category.id ? "true" : "false",
            onDragStart: (event) => {
              cancelPendingClick();
              setDragging({ kind: "category", id: category.id });
              try {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", category.id);
              } catch (error) {
                /* 某些环境不允许写 dataTransfer，拖动本身仍可用 */
              }
            },
            onDragOver: (event) => {
              if (!dragging || dragging.kind !== "category" || dragging.id === category.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (!dropTarget || dropTarget.id !== category.id) setDropTarget({ kind: "category", id: category.id });
            },
            onDragEnd: () => {
              setDragging(null);
              setDropTarget(null);
            },
            onDrop: (event) => {
              event.preventDefault();
              const source = dragging;
              setDragging(null);
              setDropTarget(null);
              if (!source || source.kind !== "category") return;
              const next = movedList(categories, source.id, category.id);
              if (next) void saveCategoryOrder(next);
            },
          };

          if (editingThis) {
            rows.push(
              h(
                "div",
                { className: "ti-row", key: category.id },
                h("input", {
                  className: "ti-rename",
                  value: renaming.value,
                  autoFocus: true,
                  onChange: (event) => setRenaming({ ...renaming, value: event.target.value }),
                  onKeyDown: (event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void commitRename();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setRenaming(null);
                    }
                  },
                  onBlur: () => {
                    void commitRename();
                  },
                }),
                h("span", { className: "ti-row-meta" }, `${category.prompts.length} 个`),
              ),
            );
            continue;
          }

          rows.push(
            h(
              "button",
              {
                type: "button",
                className: "ti-row",
                key: category.id,
                title: "拖动可排序；双击名字可改名",
                onClick: () =>
                  later(() => {
                    setError(null);
                    setView({ kind: "prompts", categoryId: category.id });
                  }),
                ...dragProps,
              },
              h(
                "span",
                {
                  className: "ti-row-name",
                  onDoubleClick: (event) => {
                    event.stopPropagation();
                    startRename("category", category);
                  },
                },
                category.name,
              ),
              h("span", { className: "ti-row-meta" }, `${category.prompts.length} 个`),
              h("span", { className: "ti-chevron", "aria-hidden": "true" }, "›"),
            ),
          );
        }

        if (categories.length === 0 && library !== null) {
          rows.push(h("p", { className: "ti-empty", key: "__empty" }, "还没有任务指令，先在下面新建一条。"));
        }

        rows.push(h("div", { className: "ti-divider", key: "__divider" }));
        rows.push(
          h(
            "button",
            { type: "button", className: "ti-row ti-row-add", key: "__new-category", onClick: startNewCategory },
            h("span", { className: "ti-row-name" }, "＋ 新建指令"),
          ),
        );
        return rows;
      };

      const renderPrompts = () => {
        const category = (library || []).find((candidate) => candidate.id === view.categoryId);
        if (!category) {
          return [
            backRow("全部指令", () => setView({ kind: "menu" })),
            h("p", { className: "ti-empty", key: "__gone" }, "这条指令已被删除。"),
          ];
        }

        const rows = [backRow(category.name, () => setView({ kind: "menu" }))];

        if (category.prompts.length === 0) {
          rows.push(h("p", { className: "ti-empty", key: "__empty" }, "这条指令下还没有提示词。"));
        }

        for (const prompt of category.prompts) {
          const using = Boolean(active && active.promptId === prompt.id);
          const editingThis = Boolean(renaming && renaming.kind === "prompt" && renaming.id === prompt.id);
          const dragProps = {
            draggable: !editingThis,
            "data-dragging": dragging && dragging.kind === "prompt" && dragging.id === prompt.id ? "true" : "false",
            "data-drop": dropTarget && dropTarget.kind === "prompt" && dropTarget.id === prompt.id ? "true" : "false",
            onDragStart: (event) => {
              cancelPendingClick();
              setDragging({ kind: "prompt", id: prompt.id });
              try {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", prompt.id);
              } catch (error) {
                /* 同上 */
              }
            },
            onDragOver: (event) => {
              if (!dragging || dragging.kind !== "prompt" || dragging.id === prompt.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (!dropTarget || dropTarget.id !== prompt.id) setDropTarget({ kind: "prompt", id: prompt.id });
            },
            onDragEnd: () => {
              setDragging(null);
              setDropTarget(null);
            },
            onDrop: (event) => {
              event.preventDefault();
              const source = dragging;
              setDragging(null);
              setDropTarget(null);
              if (!source || source.kind !== "prompt") return;
              const next = movedList(category.prompts, source.id, prompt.id);
              if (next) void savePromptOrder(category.id, next);
            },
          };

          const main = editingThis
            ? h(
                "div",
                { className: "ti-prompt-main" },
                h("input", {
                  className: "ti-rename",
                  value: renaming.value,
                  autoFocus: true,
                  onChange: (event) => setRenaming({ ...renaming, value: event.target.value }),
                  onKeyDown: (event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void commitRename();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setRenaming(null);
                    }
                  },
                  onBlur: () => {
                    void commitRename();
                  },
                }),
              )
            : h(
                "button",
                {
                  type: "button",
                  className: "ti-prompt-main",
                  title: promptPreview(prompt.text),
                  disabled: busy,
                  onClick: () =>
                    later(() => {
                      void usePrompt(category, prompt);
                    }),
                },
                h(
                  "span",
                  {
                    className: "ti-row-name",
                    onDoubleClick: (event) => {
                      event.stopPropagation();
                      startRename("prompt", prompt);
                    },
                  },
                  prompt.name,
                ),
                using ? h("span", { className: "ti-badge" }, "使用中") : null,
              );

          rows.push(
            h(
              "div",
              { className: "ti-prompt", key: prompt.id, "data-active": using ? "true" : "false", ...dragProps },
              main,
              h(
                "button",
                {
                  type: "button",
                  className: "ti-icon-btn",
                  title: "编辑这条提示词",
                  "aria-label": "编辑",
                  onClick: () => startEditPrompt(category.id, prompt),
                },
                "✎",
              ),
            ),
          );
        }

        rows.push(
          h(
            "label",
            { className: "ti-check", key: "__inline-toggle" },
            h("input", {
              type: "checkbox",
              checked: Boolean(category.insertIntoDraft),
              disabled: busy,
              onChange: () => toggleInsertIntoDraft(category),
            }),
            h("span", null, "选中后把特殊标记插入输入框（回车即运行）"),
          ),
        );

        rows.push(h("div", { className: "ti-divider", key: "__divider" }));
        rows.push(
          h(
            "button",
            { type: "button", className: "ti-row ti-row-add", key: "__new-prompt", onClick: () => startNewPrompt(category.id) },
            h("span", { className: "ti-row-name" }, "＋ 新建提示词"),
          ),
        );
        rows.push(
          h(
            "button",
            { type: "button", className: "ti-row ti-row-danger", key: "__delete-category", onClick: () => removeCategory(category) },
            h("span", { className: "ti-row-name" }, "删除这条指令"),
          ),
        );
        return rows;
      };

      const renderPromptEditor = () => {
        const editing = Boolean(view.promptId);
        return h(
          "div",
          { className: "ti-form" },
          h("label", { className: "ti-label" }, "提示词名称"),
          h("input", {
            className: "ti-input",
            value: draft.name,
            maxLength: 60,
            placeholder: "例如：阅读笔记",
            autoFocus: true,
            onChange: (event) => setDraft({ ...draft, name: event.target.value }),
          }),
          h("label", { className: "ti-label" }, "任务要求"),
          h("textarea", {
            className: "ti-textarea",
            value: draft.text,
            placeholder:
              "写下这段任务要求：输出格式、结构、字段、详略、禁止事项……\n选中后它会在本会话每一轮请求里作为固定要求生效，不需要再重复发送。",
            onChange: (event) => setDraft({ ...draft, text: event.target.value }),
          }),
          h(
            "div",
            { className: "ti-actions" },
            h("button", { type: "button", className: "ti-primary", onClick: savePrompt, disabled: busy }, "保存"),
            editing
              ? h("button", { type: "button", className: "ti-danger", onClick: removePrompt, disabled: busy }, "删除")
              : null,
            h(
              "button",
              {
                type: "button",
                className: "ti-plain",
                onClick: () => setView({ kind: "prompts", categoryId: view.categoryId }),
                disabled: busy,
              },
              "取消",
            ),
          ),
        );
      };

      const renderCategoryEditor = () => {
        const editing = Boolean(view.categoryId);
        return h(
          "div",
          { className: "ti-form" },
          h("label", { className: "ti-label" }, "指令名称"),
          h("input", {
            className: "ti-input",
            value: draft.name,
            maxLength: 60,
            placeholder: "例如：笔记 / 代码 / 周报",
            autoFocus: true,
            onChange: (event) => setDraft({ ...draft, name: event.target.value }),
          }),
          h(
            "p",
            { className: "ti-empty", style: { textAlign: "left", padding: "6px 2px" } },
            "指令是提示词的分类，例如「笔记」下面放「阅读笔记」「卡片笔记」。",
          ),
          h(
            "label",
            { className: "ti-check" },
            h("input", {
              type: "checkbox",
              checked: Boolean(draft.insertIntoDraft),
              onChange: (event) => setDraft({ ...draft, insertIntoDraft: event.target.checked }),
            }),
            h("span", null, "选中后把特殊标记插入输入框（回车即运行）"),
          ),
          h(
            "div",
            { className: "ti-actions" },
            h("button", { type: "button", className: "ti-primary", onClick: saveCategory, disabled: busy }, "保存"),
            h("button", { type: "button", className: "ti-plain", onClick: () => setView({ kind: "menu" }), disabled: busy }, "取消"),
          ),
        );
      };

      // ------------------------------------------------------------ 渲染
      const label = active ? clip(`${active.categoryName}·${active.promptName}`, 14) : "任务指令";

      const button = h(
        "button",
        {
          ref: buttonRef,
          type: "button",
          className: "ti-btn",
          "data-active": active ? "true" : "false",
          title: active
            ? `当前任务指令：${active.categoryName} / ${active.promptName}（点击切换或停用）`
            : "为这次任务选一段固定的任务要求，之后每轮自动生效",
          "aria-haspopup": "dialog",
          "aria-expanded": open ? "true" : "false",
          onClick: () => (open ? setOpen(false) : openPanel()),
        },
        h(TaskIcon),
        h("span", { className: "ti-btn-text" }, label),
        h("span", { className: "ti-caret", "aria-hidden": "true" }, "▾"),
      );

      if (!open) return button;

      let body = null;
      let title = "任务指令";
      if (view.kind === "menu") {
        body = renderMenu();
      } else if (view.kind === "prompts") {
        body = renderPrompts();
        title = "选择提示词";
      } else if (view.kind === "editPrompt") {
        body = renderPromptEditor();
        title = view.promptId ? "编辑提示词" : "新建提示词";
      } else {
        body = renderCategoryEditor();
        title = view.categoryId ? "重命名指令" : "新建指令";
      }

      const viewportWidth = typeof window === "undefined" ? 1200 : window.innerWidth;
      const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
      const panelWidth = 348;
      const margin = 12;
      const left = Math.max(margin, Math.min(anchor.left, viewportWidth - panelWidth - margin));
      const bottom = Math.max(margin, viewportHeight - anchor.top + 8);
      const maxHeight = Math.max(220, Math.min(480, anchor.top - 16));

      const panel = h(
        "div",
        {
          ref: panelRef,
          className: "ti-popover",
          role: "dialog",
          "aria-label": "任务指令",
          style: { left: `${left}px`, bottom: `${bottom}px`, width: `${panelWidth}px`, maxHeight: `${maxHeight}px` },
        },
        h(
          "div",
          { className: "ti-head" },
          h("span", { className: "ti-title" }, title),
          h(
            "span",
            { className: "ti-hint" },
            view.kind === "editPrompt" || view.kind === "editCategory" ? "保存后立即生效" : "拖动排序 · 双击改名",
          ),
        ),
        h("div", { className: "ti-body" }, body),
        error ? h("div", { className: "ti-error" }, error) : null,
      );

      return h(
        React.Fragment,
        null,
        button,
        createPortal ? createPortal(panel, document.body) : panel,
      );
    }

    // ---------------------------------------------------------------- 插件主体
    /** 需要 slots 提供挂载点。 */
    const inject = ["slots"];

    /**
     * @param {any} ctx client root context
     */
    function apply(ctx) {
      ensureStyle();
      ctx.slots.inject("conversation.input.left", () =>
        ctx.slots.register(
          {
            name: "conversation.input.left",
            id: "task-instructions",
            order: 40,
            label: "任务指令",
          },
          TaskInstructionButton,
        ),
      );

      // 捕获 sessions 服务：插 chip 时要按 sessionId 解析 session scope
      ctx.inject(["sessions"], (scope) => {
        sessionsRef = scope.sessions;
        scope.effect(() => () => {
          sessionsRef = null;
        }, "dsh-task-instructions: sessions ref");
      });

      // 把 chip 的序列化 source 注册进输入触发管线
      ctx.inject(["inputTriggers"], (scope) => {
        scope.effect(
          () => scope.inputTriggers.registerSource(instructionSource),
          "dsh-task-instructions: chip source",
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
