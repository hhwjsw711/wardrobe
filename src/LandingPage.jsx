import { useState } from "react";
import { AuthForm } from "./AuthForm.jsx";
import { CoatHanger, MagnifyingGlass, UserFocus, Sparkle } from "@phosphor-icons/react";

/**
 * Landing page shown to unauthenticated visitors.
 * Replaces the bare AuthForm with a marketing-oriented first impression.
 * Clicking "Get Started" or "Sign in" transitions to the auth form.
 */
export function LandingPage() {
  const [showAuth, setShowAuth] = useState(false);

  if (showAuth) {
    return <AuthForm />;
  }

  return (
    <div className="landing">
      {/* Nav */}
      <nav className="landing-nav">
        <div className="landing-nav-brand">
          <CoatHanger size={20} weight="duotone" />
          <span>Wardrobe</span>
        </div>
        <button className="landing-nav-btn" onClick={() => setShowAuth(true)}>
          Sign in
        </button>
      </nav>

      {/* Hero */}
      <section className="landing-hero">
        <div className="landing-hero-badge">
          <Sparkle size={14} weight="fill" />
          <span>AI-Powered</span>
        </div>
        <h1 className="landing-hero-title">
          Your wardrobe,<br />
          <span className="landing-hero-accent">finally organized.</span>
        </h1>
        <p className="landing-hero-subtitle">
          Photograph your clothes once. Let AI catalog, match, and style them for you.
          No more morning decision fatigue.
        </p>
        <div className="landing-hero-actions">
          <button className="landing-cta" onClick={() => setShowAuth(true)}>
            Get Started &mdash; Free
          </button>
          <span className="landing-hero-note">30 free credits &middot; No credit card</span>
        </div>
      </section>

      {/* Features */}
      <section className="landing-features">
        <h2 className="landing-section-title">How it works</h2>
        <div className="landing-features-grid">
          <div className="landing-feature">
            <div className="landing-feature-icon">
              <CoatHanger size={24} weight="duotone" />
            </div>
            <h3>Smart Catalog</h3>
            <p>Snap a photo &mdash; AI identifies the garment, extracts colors, tags, and type automatically.</p>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon">
              <UserFocus size={24} weight="duotone" />
            </div>
            <h3>Virtual Model</h3>
            <p>Generate modeled photos of your items on AI-generated figures. See how each piece actually looks worn.</p>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon">
              <MagnifyingGlass size={24} weight="duotone" />
            </div>
            <h3>Product Match</h3>
            <p>AI finds the closest product match for any item &mdash; brand, model, and shopping links included.</p>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon">
              <Sparkle size={24} weight="duotone" />
            </div>
            <h3>Outfit Builder</h3>
            <p>Combine items into outfits with AI-generated lookbook images. Plan your week in minutes.</p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="landing-bottom-cta">
        <h2>Start building your digital wardrobe</h2>
        <p>Free to try. Your clothes, your data, your style.</p>
        <button className="landing-cta" onClick={() => setShowAuth(true)}>
          Create Free Account
        </button>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <span>&copy; {new Date().getFullYear()} Wardrobe</span>
      </footer>
    </div>
  );
}
