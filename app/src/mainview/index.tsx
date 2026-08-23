import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { rpc } from "./api.ts";
import { App } from "./app.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

rpc.send.viewReady({});
