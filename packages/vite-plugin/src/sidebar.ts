// The board's left sidebar (shell.ts): a panel of tabs. Chats: every chat
// with Claude about an element (chats.ts), newest first, with its element,
// state and model; clicking one opens it on its element. "Resolve" archives a
// chat into the Resolved view at the bottom of the list, where it can be read
// and reopened (chats are never deleted). Changes: the
// pending edits and Implement changes (the active frame's client renders it).
//
// Add a tab with `addTab(name, element, icon, title)`: it gets a button on the
// bar that opens the sidebar on it (`buttons` lists them, `setCount` shows a
// count on one).
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
  .side-head .title { padding: 0 6px; color: var(--sp-text-strong); font-weight: 600; }
  .side-head .grow { flex: 1; }
  .side-head .close { border: none; background: none; color: var(--sp-text-dim); min-width: 24px; height: 24px; padding: 0; }
  .side-head .close:hover { color: var(--sp-text-strong); background: var(--sp-field); }
  .side-body { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--sp-line-strong) transparent; }
  .bar .side-buttons { display: contents; }
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
  .chat-row .act {
    margin: -2px 0 -2px auto; display: none; align-items: center; gap: 4px; height: 18px; padding: 0 6px; border: none;
    border-radius: var(--sp-r-sm); background: var(--sp-field); color: var(--sp-text-dim); font-size: var(--sp-fs-xs);
  }
  .chat-row:hover .act { display: inline-flex; flex: none; }
  .chat-row:hover .meta .count { display: none; }
  .chat-row .act:hover { color: var(--sp-text-strong); background: var(--sp-line-strong); }
  .chat-row.resolved .st { background: transparent; box-shadow: inset 0 0 0 1.5px var(--sp-line-strong); }
  .chat-row.resolved .el { color: var(--sp-text); }
  .chats-switch {
    display: flex; align-items: center; justify-content: flex-start; gap: 6px; width: 100%; height: 32px; padding: 0 12px; border: none; border-bottom: 1px solid var(--sp-line);
    border-radius: 0; background: none; color: var(--sp-text-dim); font: inherit; text-align: left; cursor: pointer;
  }
  .chats-switch:hover { background: var(--sp-surface); color: var(--sp-text-strong); }
  .chats-switch .n { margin-left: auto; font: var(--sp-fs-xs) var(--sp-mono); }
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
  let current = "";
  try {
    open = localStorage.getItem(STORE) === "1";
    current = localStorage.getItem(`${STORE}-tab`) ?? "";
  } catch {
    // Starts closed.
  }
  const tabs = new Map<string, { bar: HTMLElement; counts: HTMLElement[]; el: HTMLElement }>();
  const tabRow = h("div", { class: "side-head" });
  const grow = h("span", { class: "grow" });
  const close = h("button", { class: "close", title: "Close the sidebar", click: () => setOpen(false) }, icon("x"));
  // The bar's buttons pick the tab; the head just names it.
  const title = h("span", { class: "title" });
  tabRow.append(title, grow, close);
  const body = h("div", { class: "side-body" });
  const el = h("div", { class: "sidebar" }, tabRow, body);
  const buttons = h("span", { class: "side-buttons" });

  function mark() {
    for (const [n, t] of tabs) {
      if (n === current) title.textContent = n;
      t.bar.classList.toggle("on", open && n === current);
    }
  }
  function show(name: string) {
    current = name;
    try {
      localStorage.setItem(`${STORE}-tab`, name);
    } catch {
      // Not remembered.
    }
    body.replaceChildren(tabs.get(name)?.el ?? "");
    mark();
  }
  function setOpen(v: boolean) {
    open = v;
    try {
      localStorage.setItem(STORE, v ? "1" : "0");
    } catch {
      // Not remembered.
    }
    mark();
    onToggle(v);
  }
  return {
    el,
    /** For the bar: a button per tab (added as tabs are), each opening the sidebar on its tab, or closing it when it's already showing. */
    buttons,
    /** A count on a tab and its bar button (open chats, pending changes); 0 hides it. */
    setCount: (name: string, n: number) => {
      for (const c of tabs.get(name)?.counts ?? []) c.textContent = n ? String(n) : "";
    },
    isOpen: () => open,
    setOpen,
    /** Open the sidebar on a tab. */
    showTab: (name: string) => {
      show(name);
      if (!open) setOpen(true);
    },
    addTab(name: string, content: HTMLElement, iconName: Parameters<typeof icon>[0], title: string) {
      const counts = [h("span", { class: "count" })];
      const bar = h("button", { class: "side-toggle", title }, icon(iconName, 13), name, counts[0]);
      bar.addEventListener("click", () => {
        if (open && current === name) setOpen(false);
        else {
          show(name);
          if (!open) setOpen(true);
        }
      });
      buttons.append(bar);
      tabs.set(name, { bar, counts, el: content });
      if (!current || !tabs.has(current) || current === name) show(current && tabs.has(current) ? current : name);
    },
    /** Start in the state it was left in. */
    init: () => {
      if (!tabs.has(current)) show(tabs.keys().next().value ?? "");
      setOpen(open);
    },
  };
}

// ---------------------------------------------------------------------------
// The Chats tab

type ChatMessage = { role: "user" | "claude"; text: string; ok?: boolean; at: number };
type Chat = { id: string; key: string; label: string; sessionId: string | null; model?: string; messages: ChatMessage[]; created: number; updated: number; closed?: boolean; resolved?: boolean; kind?: "implement" | "task" };

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
  /** Chats whose element isn't on the board (and runs, and resolved chats), shown inline instead. */
  const expanded = new Set<string>();
  /** The Chats list, or the Resolved view (chats archived with "Resolve"). */
  let view: "list" | "resolved" = "list";

  function render() {
    if (!chats.length) {
      el.replaceChildren(h("div", { class: "chats-empty" }, "No chats yet. Select an element in Edit mode and ask Claude about it in its popup."));
      return;
    }
    const resolvedView = view === "resolved";
    const shown = chats.filter((c) => !!c.resolved === resolvedView);
    const resolvedCount = chats.filter((c) => c.resolved).length;
    const rows = [...shown].sort((a, b) => b.updated - a.updated).map((c) => {
      const last = c.messages.at(-1);
      const first = c.messages.find((m) => m.role === "user");
      const busy = running === c.id;
      // A chat with no element (an Implement changes run, a task): its transcript opens here.
      const run = !!c.kind;
      const state = busy
        ? c.kind === "implement"
          ? "Claude is implementing"
          : c.kind === "task"
            ? "Claude is working"
            : "Claude is answering"
        : last?.ok === false
          ? "Failed"
          : c.resolved
            ? "Resolved"
            : run
              ? last?.role === "claude"
                ? "Done"
                : "Stopped"
              : c.closed
                ? "Closed"
                : "Open";
      const cls = `chat-row${run && !c.resolved ? " run" : ""}${c.closed && !run && !c.resolved ? " closed" : ""}${c.resolved ? " resolved" : ""}${busy ? " busy" : ""}${!busy && last?.ok === false ? " bad" : ""}`;
      // Resolve archives the chat (not while Claude is answering it); Reopen brings it back to the list.
      const act = busy
        ? null
        : c.resolved
          ? h("button", { class: "act", title: "Reopen this chat: back in the Chats list, and open on its element" }, icon("rotate-ccw", 11), h("span", {}, "Reopen"))
          : h("button", { class: "act", title: "Resolve this chat: it moves to Resolved, where you can still read and reopen it" }, icon("check", 11), h("span", {}, "Resolve"));
      act?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!c.resolved) {
          expanded.delete(c.id);
          deps.send("spark:chat-resolve", { id: c.id });
          return;
        }
        deps.send("spark:chat-open", { id: c.id });
        view = "list";
        if (run || !deps.open(c)) expanded.add(c.id);
        else expanded.delete(c.id);
        render();
      });
      const row = h(
        "div",
        { class: cls, title: `${state}${c.sessionId ? ` · session ${c.sessionId}` : ""}`, role: "button", tabindex: "-1", "data-chat": c.id },
        h("span", { class: "st" }),
        h("div", { class: "top" }, h("span", { class: "el" }, c.label || "Element"), h("span", { class: "when" }, ago(c.updated))),
        first ? h("div", { class: "first" }, first.text) : null,
        h(
          "div",
          { class: "meta" },
          h("span", {}, state),
          c.model ? h("span", { class: "model" }, modelName(c.model)) : null,
          h("span", { class: "count" }, `${c.messages.length} message${c.messages.length === 1 ? "" : "s"}`),
          act,
        ),
      );
      if (expanded.has(c.id)) {
        if (!run && !c.resolved) row.append(h("div", { class: "missing" }, "This element isn't on the board right now."));
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
        // Runs and resolved chats are read here, in the list.
        if (run || c.resolved) {
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
    const switchTo = (v: typeof view) => () => {
      view = v;
      render();
      el.closest(".side-body")?.scrollTo({ top: 0 });
    };
    if (resolvedView) {
      const back = h("button", { class: "chats-switch", title: "Back to the Chats list", click: switchTo("list") }, icon("chevron-left", 13), h("span", {}, "Resolved chats"));
      el.replaceChildren(back, ...(rows.length ? rows : [h("div", { class: "chats-empty" }, "No resolved chats.")]));
      return;
    }
    const empty = h("div", { class: "chats-empty" }, "No open chats. Resolved ones are in Resolved below.");
    const toResolved = resolvedCount
      ? h("button", { class: "chats-switch", title: "Chats you resolved: read or reopen them", click: switchTo("resolved") }, icon("archive", 13), "Resolved", h("span", { class: "n" }, String(resolvedCount)))
      : null;
    el.replaceChildren(...(rows.length ? rows : [empty]), ...(toResolved ? [toResolved] : []));
  }
  render();
  // Keep "2m ago" fresh.
  setInterval(render, 60_000);
  return {
    el,
    update(list: Chat[], run: string | null) {
      chats = list;
      running = run;
      // Nothing left to show in Resolved (the last one was reopened): back to the list.
      if (view === "resolved" && !chats.some((c) => c.resolved)) view = "list";
      render();
    },
    /** Show a chat's transcript open in the list (a run with no element, as it starts). */
    reveal(id: string) {
      if (!chats.some((c) => c.id === id && c.kind && !c.resolved)) return false;
      view = "list";
      expanded.add(id);
      render();
      el.querySelector(`[data-chat="${id}"]`)?.scrollIntoView({ block: "nearest" });
      return true;
    },
    openCount: () => chats.filter((c) => !c.closed && !c.kind && c.messages.length).length,
  };
}
