// The board's left sidebar (shell.ts): a panel of tabs. Chats is the first:
// every chat with Claude about an element (chats.ts), newest first, with its
// element, state and model; clicking one opens it on its element.
//
// Add a tab with `addTab(name, element)`.
import { h } from "./fields.ts";
import { markdown, MARKDOWN_STYLE } from "./markdown.ts";
import { icon } from "./theme.ts";

export const SIDEBAR_W = 280;

export const SIDEBAR_STYLE = `
  .sidebar {
    position: absolute; left: 0; bottom: 0; width: ${SIDEBAR_W}px; display: none; flex-direction: column;
    background: var(--sp-bg); color: var(--sp-text); border-right: 1px solid var(--sp-line);
    font: var(--sp-fs-md)/1.45 var(--sp-font);
  }
  .side-open .sidebar { display: flex; }
  .side-open .canvas { left: ${SIDEBAR_W}px; }
  .side-head { display: flex; align-items: center; gap: 2px; height: 36px; padding: 0 6px; border-bottom: 1px solid var(--sp-line); flex: none; }
  .side-head .tab {
    height: 24px; padding: 0 8px; border: none; background: none; color: var(--sp-text-dim); font-weight: 600; min-width: 0;
  }
  .side-head .tab.on { color: var(--sp-text-strong); background: var(--sp-field); }
  .side-head .grow { flex: 1; }
  .side-head .close { border: none; background: none; color: var(--sp-text-dim); min-width: 24px; height: 24px; padding: 0; }
  .side-head .close:hover { color: var(--sp-text-strong); background: var(--sp-field); }
  .side-body { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--sp-line-strong) transparent; }
  .bar .side-toggle { display: inline-flex; align-items: center; gap: 6px; }
  .bar .side-toggle.on { background: var(--sp-line-strong); color: var(--sp-text-strong); }
  .bar .side-toggle .count { color: var(--sp-text-dim); font: var(--sp-fs-xs) var(--sp-mono); }

  .chats-empty { padding: 16px 14px; color: var(--sp-text-dim); }
  .chat-row {
    position: relative; display: block; width: 100%; height: auto; padding: 9px 12px 9px 28px; border: none; border-bottom: 1px solid var(--sp-line);
    border-radius: 0; background: none; color: var(--sp-text); text-align: left; cursor: pointer; font: inherit;
  }
  .chat-row:hover { background: var(--sp-surface); }
  .chat-row.closed { color: var(--sp-text-dim); }
  .chat-row .st { position: absolute; left: 11px; top: 14px; width: 8px; height: 8px; border-radius: 50%; background: var(--sp-accent); }
  .chat-row.closed .st { background: transparent; box-shadow: inset 0 0 0 1.5px var(--sp-line-strong); }
  .chat-row.run .st { background: var(--sp-component); }
  .chat-row.bad .st { background: var(--sp-danger); }
  .chat-row.busy .st {
    left: 9px; top: 12px; width: 12px; height: 12px; background: none; border: 2px solid var(--sp-line-strong); border-top-color: var(--sp-accent);
    animation: side-spin .8s linear infinite;
  }
  @keyframes side-spin { to { transform: rotate(360deg); } }
  .chat-row .top { display: flex; align-items: baseline; gap: 6px; }
  .chat-row .el { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--sp-text-strong); }
  .chat-row.closed .el { color: var(--sp-text); }
  .chat-row .when { flex: none; color: var(--sp-text-dim); font-size: var(--sp-fs-xs); }
  .chat-row .first { margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sp-text-dim); }
  .chat-row .meta { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: var(--sp-text-dim); font-size: var(--sp-fs-xs); }
  .chat-row .model { padding: 1px 5px; border-radius: var(--sp-r-sm); background: var(--sp-field); color: var(--sp-text); }
  .chat-row .del {
    position: absolute; right: 8px; bottom: 7px; display: none; height: 18px; padding: 0 6px; border: none; border-radius: var(--sp-r-sm);
    background: var(--sp-field); color: var(--sp-text-dim); font-size: var(--sp-fs-xs);
  }
  .chat-row:hover .del { display: block; }
  .chat-row .del:hover, .chat-row .del.sure { color: var(--sp-text-strong); background: var(--sp-danger); }
  .chat-row .missing { margin-top: 6px; color: var(--sp-warn); font-size: var(--sp-fs-sm); }
  .chat-log { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; cursor: text; user-select: text; }
  .chat-log .u { align-self: flex-end; max-width: 92%; padding: 4px 8px; border-radius: 8px 8px 2px 8px; background: color-mix(in srgb, var(--sp-accent) 22%, var(--sp-field)); color: var(--sp-text-strong); white-space: pre-wrap; }
  .chat-log .c { max-width: 100%; }
  ${MARKDOWN_STYLE}
`;

/** The sidebar: a toggle for the bar, the panel, and a way to add tabs. */
export function sidebar(onToggle: (open: boolean) => void) {
  const STORE = "spark:sidebar";
  let open = false;
  try {
    open = localStorage.getItem(STORE) === "1";
  } catch {
    // Starts closed.
  }
  const tabs = new Map<string, { btn: HTMLElement; el: HTMLElement }>();
  let current = "";
  const tabRow = h("div", { class: "side-head" });
  const grow = h("span", { class: "grow" });
  const close = h("button", { class: "close", title: "Close the sidebar", click: () => setOpen(false) }, icon("x"));
  tabRow.append(grow, close);
  const body = h("div", { class: "side-body" });
  const el = h("div", { class: "sidebar" }, tabRow, body);
  const count = h("span", { class: "count" });
  const toggle = h("button", { class: "side-toggle", title: "Chats with Claude, on every element" }, icon("message-circle", 13), "Chats", count);
  toggle.addEventListener("click", () => setOpen(!open));

  function show(name: string) {
    current = name;
    for (const [n, t] of tabs) t.btn.classList.toggle("on", n === name);
    body.replaceChildren(tabs.get(name)?.el ?? "");
  }
  function setOpen(v: boolean) {
    open = v;
    toggle.classList.toggle("on", v);
    try {
      localStorage.setItem(STORE, v ? "1" : "0");
    } catch {
      // Not remembered.
    }
    onToggle(v);
  }
  return {
    el,
    toggle,
    /** Shown on the bar's button (open chats). */
    setCount: (n: number) => (count.textContent = n ? String(n) : ""),
    isOpen: () => open,
    setOpen,
    addTab(name: string, content: HTMLElement) {
      const btn = h("button", { class: "tab", click: () => show(name) }, name);
      tabRow.insertBefore(btn, grow);
      tabs.set(name, { btn, el: content });
      if (!current) show(name);
    },
    /** Start in the state it was left in. */
    init: () => setOpen(open),
  };
}

// ---------------------------------------------------------------------------
// The Chats tab

type ChatMessage = { role: "user" | "claude"; text: string; ok?: boolean; at: number };
type Chat = { id: string; key: string; label: string; sessionId: string | null; model?: string; messages: ChatMessage[]; created: number; updated: number; closed?: boolean; kind?: "implement" };

/** "claude-sonnet-5-5" as people say it: "Sonnet 5.5". */
function modelName(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[.*\])?$/i);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : id;
}

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export type ChatsDeps = {
  /** Open the chat on its element (selects its frame and the element). False when it isn't on the board. */
  open: (chat: Chat) => boolean;
  send: (event: string, data: unknown) => void;
};

/** The Chats tab's content; `update` with the server's list and the running chat. */
export function chatsTab(deps: ChatsDeps) {
  const el = h("div", { class: "chats" });
  let chats: Chat[] = [];
  let running: string | null = null;
  /** Chats whose element isn't on the board, shown inline instead. */
  const expanded = new Set<string>();
  let sure: string | null = null;

  function render() {
    if (!chats.length) {
      el.replaceChildren(h("div", { class: "chats-empty" }, "No chats yet. Select an element in Edit mode and ask Claude about it in its popup."));
      return;
    }
    const rows = [...chats].sort((a, b) => b.updated - a.updated).map((c) => {
      const last = c.messages.at(-1);
      const first = c.messages.find((m) => m.role === "user");
      const busy = running === c.id;
      // An Implement changes run has no element: its transcript opens here.
      const run = c.kind === "implement";
      const state = busy
        ? run
          ? "Claude is implementing"
          : "Claude is answering"
        : last?.ok === false
          ? "Failed"
          : run
            ? last?.role === "claude"
              ? "Done"
              : "Stopped"
            : c.closed
              ? "Closed"
              : "Open";
      const cls = `chat-row${run ? " run" : ""}${c.closed && !run ? " closed" : ""}${busy ? " busy" : ""}${!busy && last?.ok === false ? " bad" : ""}`;
      const del = h("button", { class: `del${sure === c.id ? " sure" : ""}`, title: "Delete this chat" }, sure === c.id ? "Delete?" : "Delete");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        if (sure !== c.id) {
          sure = c.id;
          render();
          setTimeout(() => {
            if (sure === c.id) {
              sure = null;
              render();
            }
          }, 3000);
          return;
        }
        sure = null;
        deps.send("spark:chat-delete", { id: c.id });
      });
      const row = h(
        "div",
        { class: cls, title: `${state}${c.sessionId ? ` · session ${c.sessionId}` : ""}`, role: "button", tabindex: "-1" },
        h("span", { class: "st" }),
        h("div", { class: "top" }, h("span", { class: "el" }, c.label || "Element"), h("span", { class: "when" }, ago(c.updated))),
        first ? h("div", { class: "first" }, first.text) : null,
        h(
          "div",
          { class: "meta" },
          h("span", {}, state),
          c.model ? h("span", { class: "model" }, modelName(c.model)) : null,
          h("span", {}, `${c.messages.length} message${c.messages.length === 1 ? "" : "s"}`),
        ),
        del,
      );
      if (expanded.has(c.id)) {
        if (!run) row.append(h("div", { class: "missing" }, "This element isn't on the board right now."));
        row.append(
          h(
            "div",
            { class: "chat-log" },
            ...c.messages.map((m) => (m.role === "user" ? h("div", { class: "u" }, m.text) : h("div", { class: "c md" }, markdown(m.text)))),
          ),
        );
      }
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".chat-log")) return;
        if (run) {
          if (expanded.has(c.id)) expanded.delete(c.id);
          else expanded.add(c.id);
          render();
          return;
        }
        if (c.closed) deps.send("spark:chat-open", { id: c.id });
        if (deps.open(c)) expanded.delete(c.id);
        else if (expanded.has(c.id)) expanded.delete(c.id);
        else expanded.add(c.id);
        render();
      });
      return row;
    });
    el.replaceChildren(...rows);
  }
  render();
  // Keep "2m ago" fresh.
  setInterval(render, 60_000);
  return {
    el,
    update(list: Chat[], run: string | null) {
      chats = list;
      running = run;
      render();
    },
    openCount: () => chats.filter((c) => !c.closed && !c.kind && c.messages.length).length,
  };
}
