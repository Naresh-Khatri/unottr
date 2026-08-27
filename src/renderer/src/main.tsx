import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { ActivityProvider } from "./lib/ActivityProvider";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ActivityProvider>
      <App />
    </ActivityProvider>
  </React.StrictMode>,
);
