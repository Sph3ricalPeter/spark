import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Manrope (OFL, Google) ships with the app as one variable font.
import "@fontsource-variable/manrope/wght.css";
import "./tokens.css";
import "./styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
