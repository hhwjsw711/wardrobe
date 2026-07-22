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
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "2rem", textAlign: "center" }}>
          <h2>Something went wrong</h2>
          <p style={{ color: "#888", marginBottom: "1rem" }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
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
