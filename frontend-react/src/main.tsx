import ReactDOM from "react-dom/client";
import OriginalViewer from "./compat/OriginalViewer";

// The compatibility island has document-lifetime listeners. Do not repeatedly
// mount it or run it under StrictMode's effect replay. The experimental App.tsx
// remains source-only until it reaches feature and visual parity.
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
ReactDOM.createRoot(root).render(<OriginalViewer />);
