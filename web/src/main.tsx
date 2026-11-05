import { createRoot } from "react-dom/client";
import "./fonts.css";
import "./vendor/globals.css";
import "./vendor/shared.css";
import "./style.css";
import App from "./App";
import { UIProvider } from "./ui";
import ToastHost from "./ToastHost";

createRoot(document.getElementById("root")!).render(
  <UIProvider>
    <App />
    <ToastHost />
  </UIProvider>,
);
