import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Inter (OFL) ships with the app as one variable font.
import "@fontsource-variable/inter/wght.css";
import "./tokens.css";
import "./styles.css";
import { App } from "./App";

// No browser (WebView2) context menu in Spark: only in text fields, where
// cut, copy and paste still help, and on selected text.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  const field = !!t && (t.isContentEditable || t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/.test((t as HTMLInputElement).type)));
  const selected = !!window.getSelection()?.toString();
  if (!e.defaultPrevented && !field && !selected) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
