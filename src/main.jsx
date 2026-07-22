import React from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { App } from "./App.jsx";
import "./styles.css";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    // A-28: Persist error state across remounts via sessionStorage
    const persisted = (() => {
      try {
        const stored = sessionStorage.getItem("__error_boundary");
        if (stored) return JSON.parse(stored);
      } catch {}
      return null;
    })();
    this.state = persisted || { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    const state = { hasError: true, error: { message: error.message, stack: error.stack } };
    try { sessionStorage.setItem("__error_boundary", JSON.stringify(state)); } catch {}
    return state;
  }

  componentDidCatch(error, info) {
    console.error("[ErrorBoundary]", error, info);
  }

  handleReset = () => {
    try { sessionStorage.removeItem("__error_boundary"); } catch {}
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "2rem", textAlign: "center" }}>
          <h2>Something went wrong</h2>
          <p style={{ color: "#888", marginBottom: "1rem" }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={this.handleReset}
            style={{ padding: "0.5rem 1rem", cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ConvexAuthProvider client={convex}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </ConvexAuthProvider>
  </React.StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}
