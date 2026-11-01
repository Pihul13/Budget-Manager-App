import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import LocalGate from "./LocalGate.jsx";
import "./styles.css";
import "./mobile.css";
import "./auth.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <LocalGate />
    </BrowserRouter>
  </React.StrictMode>,
);
