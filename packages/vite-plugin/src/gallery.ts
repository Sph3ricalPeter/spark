// The Components view: every component on its own, with mock data.
//
// A component gets cases from a `*.spark.tsx` file next to it. Each exported
// function is one case, rendered alone in its own card:
//
//   // Meter.spark.tsx
//   import { Meter } from "./Meter";
//   export const Quiet = () => <Meter level={0.2} />;
//   export const Loud = () => <Meter level={0.9} />;
//
// An optional `spark.setup.tsx` in the project root can export a default
// `Wrapper` component (providers, a theme) that wraps every case, and
// `tauri`: an object of command name → (args) => result, which fakes the
// app's own Tauri commands (its Rust side doesn't run inside Spark).
//
// On the board (shell.ts) each file gets a frame of its own
// (`?spark=components&file=/src/ui/Meter.spark.tsx`): its cases in a row, no
// title (the frame has one), and the frame is sized to them.
//
// The page runs in the shell's frame (`?spark=components`) instead of the app,
// with the app's global CSS (see index.ts), and the Spark client loads on top
// as usual, so every case can be selected, edited, and implemented. Runs with
// the app's own React, which the generated module passes in.
import type * as ReactNS from "react";
import type { createRoot as CreateRoot } from "react-dom/client";
import { UI_FONT, installFont } from "./fonts.ts";

type Module = Record<string, unknown>;
type Setup = { default?: ReactNS.ComponentType<{ children: ReactNS.ReactNode }>; tauri?: Record<string, (args: unknown) => unknown> };

export type GalleryInput = {
  React: typeof ReactNS;
  createRoot: typeof CreateRoot;
  /** `*.spark.tsx` modules by root-relative path. */
  files: Record<string, Module>;
  setup: Setup | undefined;
};

const STYLE = `
  .spark-gallery {
    box-sizing: border-box; min-height: 100vh; padding: 32px;
    font: 12px/1.4 ${UI_FONT};
  }
  .spark-gallery * { box-sizing: border-box; }
  /* One file in its own board frame (shell.ts): as big as its cases, no title. */
  .spark-gallery.one { min-height: 0; width: max-content; padding: 24px; }
  /* A component frame never scrolls: the board sizes it to the cases. */
  html.spark-one, html.spark-one body { overflow: hidden !important; }
  .spark-gallery.one .spark-gallery-file { margin: 0; }
  .spark-gallery.one .spark-gallery-cases { flex-wrap: nowrap; }
  .spark-gallery.one.stack .spark-gallery-cases { flex-direction: column; }
  .spark-gallery.one .spark-gallery-empty { margin: 0; }
  .spark-gallery-file { margin: 0 0 40px; }
  .spark-gallery-file > h2 {
    all: unset; display: block; margin: 0 0 12px; font: 600 13px/1.2 ${UI_FONT}; color: #8a8f98;
  }
  .spark-gallery-file > h2 code { font: 11px ui-monospace, monospace; color: #6b7079; margin-left: 8px; }
  .spark-gallery-cases { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
  .spark-gallery-case > .spark-gallery-name { font: 500 11px/1 ${UI_FONT}; color: #8a8f98; margin: 0 0 6px; cursor: text; outline: none; }
  .spark-gallery-case > .spark-gallery-name[contenteditable="plaintext-only"] { color: #fff; box-shadow: 0 1px 0 #4f8cff; }
  /* A containing block for the case's absolute and fixed parts (readouts, popovers), so each stays in its own box. */
  .spark-gallery-case > .spark-gallery-stage {
    position: relative; contain: layout; padding: 24px; border: 1px dashed rgba(138, 143, 152, 0.35); border-radius: 8px; min-width: 120px;
  }
  .spark-gallery-error { color: #e5534b; font: 11px/1.4 ui-monospace, monospace; white-space: pre-wrap; max-width: 360px; }
  .spark-gallery-empty { max-width: 520px; margin: 64px auto; color: #8a8f98; font: 13px/1.6 ${UI_FONT}; }
  .spark-gallery-empty h2 { all: unset; display: block; color: inherit; font: 600 15px/1.3 ${UI_FONT}; margin-bottom: 8px; }
  .spark-gallery-empty pre {
    background: rgba(138, 143, 152, 0.1); border-radius: 6px; padding: 12px; font: 12px/1.5 ui-monospace, monospace;
    color: inherit; overflow: auto;
  }
  .spark-gallery-empty button {
    font: 600 12px ${UI_FONT}; color: #fff; background: #4f8cff; border: none; border-radius: 6px; padding: 8px 14px;
    cursor: pointer;
  }
  .spark-gallery-empty button:disabled { opacity: 0.6; cursor: default; }
`;

/**
 * A case whose component is positioned absolutely or fixed (a readout, a
 * popover) takes no room in its box: grow the box to hold it, so the cases
 * don't pile up on each other. Only parts that stick out past the box count,
 * so a part sized to the box (width: 100%) never makes it grow.
 */
function fitStages(root: HTMLElement) {
  for (const stage of Array.from(root.querySelectorAll<HTMLElement>(".spark-gallery-stage"))) {
    stage.style.minWidth = stage.style.minHeight = "";
    const box = stage.getBoundingClientRect();
    let right = box.right;
    let bottom = box.bottom;
    for (const d of Array.from(stage.querySelectorAll("*"))) {
      const pos = getComputedStyle(d).position;
      if (pos !== "absolute" && pos !== "fixed") continue;
      const r = d.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    const pad = 24;
    if (right > box.right + 0.5) stage.style.minWidth = `${Math.ceil(right - box.left + pad)}px`;
    if (bottom > box.bottom + 0.5) stage.style.minHeight = `${Math.ceil(bottom - box.top + pad)}px`;
  }
}

/** A component frame stacks its cases when one is wider than this. */
const STACK_W = 360;

/** "QuietLevel" → "Quiet level": a case as the board names it. */
export function words(name: string) {
  const s = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** "Very quiet" → "VeryQuiet": a case name as an export name, or "" if there's nothing to name. */
function identifier(text: string) {
  const parts = text.trim().split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  const id = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return !id ? "" : /^[0-9]/.test(id) ? `_${id}` : id;
}

/** "/src/ui/Meter.spark.tsx" → "Meter". */
function fileTitle(path: string) {
  return path.split("/").pop()!.replace(/\.spark\.[jt]sx?$/, "");
}

/**
 * Answer the app's own `invoke` calls from the setup's fakes. Inside Spark's
 * window the frame already has Tauri (mode.ts, borrowTauri), which asks the
 * fakes first; in a plain browser there's none, so fake the rest too.
 */
function fakeTauri(fakes: Setup["tauri"]) {
  if (!fakes) return;
  window.__sparkTauriFakes = fakes;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (w.__TAURI_INTERNALS__) return;
  let next = 1;
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: () => next++,
    invoke: async (cmd: string, args: unknown) => {
      if (cmd in fakes) return fakes[cmd](args);
      // Events: listening succeeds and nothing ever arrives.
      if (cmd.startsWith("plugin:event|")) return next++;
      throw new Error(`spark.setup: no fake for Tauri command "${cmd}"`);
    },
  };
}

export function mountGallery({ React, createRoot, files, setup }: GalleryInput) {
  const h = React.createElement;
  installFont();
  fakeTauri(setup?.tauri);

  if (!document.querySelector("style[data-spark='gallery']")) {
    const style = document.createElement("style");
    style.setAttribute("data-spark", "gallery");
    style.textContent = STYLE;
    document.head.append(style);
  }
  // The app's own mount point stays empty; the gallery gets its own.
  const params = new URLSearchParams(location.search);
  const one = params.has("file");
  const only = params.get("file");
  if (only) files = Object.fromEntries(Object.entries(files).filter(([p]) => p === only));
  const g = window as unknown as { __sparkGallery?: ReturnType<typeof CreateRoot> };
  if (!g.__sparkGallery) {
    // The app's empty mount points (#root and friends) would take up the page.
    for (const child of Array.from(document.body.children)) {
      if (child instanceof HTMLElement && child.tagName === "DIV" && child.childNodes.length === 0) child.style.display = "none";
    }
    const el = document.createElement("div");
    el.className = one ? "spark-gallery one" : "spark-gallery";
    document.body.append(el);
    if (one) {
      // Cases sit in a row, or stack in a column: "auto" stacks wide ones
      // (a case wider than STACK_W), the board's toggle picks one for good.
      let layout = params.get("layout") ?? "auto";
      const arrange = () => {
        fitStages(el);
        const widest = Math.max(0, ...Array.from(el.querySelectorAll(".spark-gallery-case"), (c) => c.getBoundingClientRect().width));
        el.classList.toggle("stack", layout === "column" || (layout === "auto" && widest > STACK_W));
        // The board sizes the frame to the cases (with the page's own margin
        // around them), and to anything that sticks out of them.
        const r = el.getBoundingClientRect();
        let right = r.right;
        let bottom = r.bottom;
        for (const d of Array.from(el.querySelectorAll("*"))) {
          const dr = d.getBoundingClientRect();
          if (!dr.width && !dr.height) continue;
          right = Math.max(right, dr.right);
          bottom = Math.max(bottom, dr.bottom);
        }
        window.parent.__sparkShell?.contentSize(window, right + r.left, bottom + r.top, el.classList.contains("stack"));
      };
      document.documentElement.classList.add("spark-one");
      // The cases can change size on their own (fonts, images, state): measure again.
      const ro = new ResizeObserver(() => arrange());
      ro.observe(el);
      new MutationObserver(() => {
        for (const c of Array.from(el.querySelectorAll(".spark-gallery-stage"))) ro.observe(c);
      }).observe(el, { childList: true, subtree: true });
      void document.fonts?.ready.then(arrange);
      (window as unknown as { __sparkLayout?: (v: string) => void }).__sparkLayout = (v) => {
        layout = v;
        arrange();
      };
    }
    g.__sparkGallery = createRoot(el);
  }

  /** One broken case shouldn't take the others down. */
  class Boundary extends React.Component<{ children: ReactNS.ReactNode }, { error: Error | null }> {
    /** The client's owner paths stop here: what's above is the gallery, not the app. */
    static sparkInternal = true;
    state = { error: null as Error | null };
    static getDerivedStateFromError(error: Error) {
      return { error };
    }
    render() {
      return this.state.error ? h("div", { className: "spark-gallery-error" }, String(this.state.error.stack ?? this.state.error)) : this.props.children;
    }
  }

  /** A case's name: double-click to rename it (renames the export in its file). */
  function CaseName({ file, name }: { file: string; name: string }) {
    const commit = (el: HTMLElement) => {
      const to = identifier(el.textContent ?? "");
      if (to && to !== name) import.meta.hot?.send("spark:rename-case", { file: file.replace(/^\//, ""), from: name, to });
      else el.textContent = words(name);
    };
    return h(
      "div",
      {
        className: "spark-gallery-name",
        title: "Double-click to rename",
        onDoubleClick: (e: ReactNS.MouseEvent<HTMLDivElement>) => {
          e.stopPropagation();
          const el = e.currentTarget;
          el.contentEditable = "plaintext-only";
          el.focus();
          getSelection()?.selectAllChildren(el);
        },
        onKeyDown: (e: ReactNS.KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.currentTarget.textContent = words(name);
            e.currentTarget.blur();
          }
          e.stopPropagation();
        },
        onBlur: (e: ReactNS.FocusEvent<HTMLDivElement>) => {
          e.currentTarget.contentEditable = "false";
          commit(e.currentTarget);
        },
      },
      words(name),
    );
  }

  const Wrapper = setup?.default ?? React.Fragment;
  const sections = Object.entries(files)
    .sort(([a], [b]) => fileTitle(a).localeCompare(fileTitle(b)))
    .map(([path, mod]) => {
      // In the order they're written (index.ts adds __sparkOrder); a namespace lists them alphabetically.
      const order = Array.isArray(mod.__sparkOrder) ? (mod.__sparkOrder as string[]) : Object.keys(mod);
      const cases = order.filter((k) => typeof mod[k] === "function").map((k) => [k, mod[k]]) as [string, ReactNS.ComponentType][];
      return h(
        "section",
        { key: path, className: "spark-gallery-file" },
        one ? null : h("h2", {}, fileTitle(path), h("code", {}, path.replace(/^\//, ""))),
        h(
          "div",
          { className: "spark-gallery-cases" },
          cases.map(([name, Case]) =>
            h(
              "div",
              // The variant box: Spark selects it as a whole (client.ts targetOf), to Ask Claude about this case.
              { key: name, className: "spark-gallery-case", "data-spark-case": name, "data-spark-case-file": path },
              h(CaseName, { key: "name", file: path, name }),
              h("div", { className: "spark-gallery-stage" }, h(Boundary, null, h(Wrapper, null, h(Case)))),
            ),
          ),
        ),
      );
    });

  g.__sparkGallery.render(sections.length ? h(React.StrictMode, null, sections) : h(Empty, { h }));
}

/** No `*.spark.tsx` yet: how to add one, or have Claude write them. */
function Empty({ h }: { h: typeof ReactNS.createElement }) {
  const example = `// src/ui/Button.spark.tsx\nimport { Button } from "./Button";\n\nexport const Default = () => <Button>Save</Button>;\nexport const Primary = () => <Button variant="primary">Export</Button>;`;
  return h(
    "div",
    { className: "spark-gallery-empty" },
    h("h2", {}, "No components to show yet"),
    h("p", {}, "Add a ", h("code", {}, "*.spark.tsx"), " file next to a component. Each function it exports is one case, rendered here on its own with the props you give it:"),
    h("pre", {}, example),
    h("p", {}, "Or let Claude write them for the components in this project (it's a chat in Chats):"),
    h(
      "button",
      {
        className: "spark-gallery-write",
        onClick: (e: ReactNS.MouseEvent<HTMLButtonElement>) => {
          e.currentTarget.disabled = true;
          e.currentTarget.textContent = "Claude is writing them…";
          import.meta.hot?.send("spark:gallery-generate", {});
        },
      },
      WRITE,
    ),
  );
}

const WRITE = "Write them with Claude";
/** The run ended (its reply is in its chat) or Claude was busy: the button can be pressed again. */
function resetWrite(text = WRITE) {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".spark-gallery-write")) {
    if (!b.disabled) continue;
    b.disabled = false;
    b.textContent = text;
  }
}
import.meta.hot?.on("spark:run", (e: { type: string }) => {
  if (e.type === "done" || e.type === "error") resetWrite();
});
import.meta.hot?.on("spark:busy", () => resetWrite(`Claude is busy in another chat. ${WRITE}`));
