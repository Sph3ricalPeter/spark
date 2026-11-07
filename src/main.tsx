import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Inter (OFL) ships with the app as one variable font.
import "@fontsource-variable/inter/wght.css";
import "./tokens.css";
import "./styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
