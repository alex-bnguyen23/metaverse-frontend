import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

// Mount into the HTML entry point. StrictMode repeats effect setup and cleanup in
// development to help reveal missing cleanup in code such as the Three.js scene.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
