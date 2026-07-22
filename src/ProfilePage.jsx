import { useCallback, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { ArrowLeft, Copy, FloppyDisk, Key, Trash, User, WarningCircle } from "@phosphor-icons/react";

/**
 * Profile & Account page.
 * Shows user info, wardrobe stats, style insights, MCP API key, and account actions.
 * Full-screen overlay on top of the main wardrobe view.
 */
export function ProfilePage({ onClose }) {
  const profile = useQuery(api.profile.getProfile);
  const updateProfile = useMutation(api.profile.updateProfile);
  const mcpApiKey = useQuery(api.profile.getMcpApiKey);
  const generateMcpApiKey = useMutation(api.profile.generateMcpApiKey);
  const revokeMcpApiKey = useMutation(api.profile.revokeMcpApiKey);

  const [editingName, setEditingName] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [mcpGenerating, setMcpGenerating] = useState(false);
  const [mcpCopied, setMcpCopied] = useState(false);

  const handleSaveName = useCallback(async () => {
    if (editingName === null) return;
    const trimmed = editingName.trim();
    if (!trimmed) return;
    setSaving(true);
    setSaveError("");
    try {
      await updateProfile({ name: trimmed });
      setEditingName(null);
    } catch (err) {
      setSaveError(err?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [editingName, updateProfile]);

  const handleCopyKey = useCallback(async () => {
    if (!mcpApiKey) return;
    try {
      await navigator.clipboard.writeText(mcpApiKey);
      setMcpCopied(true);
      setTimeout(() => setMcpCopied(false), 2000);
    } catch {}
  }, [mcpApiKey]);

  const handleGenerateKey = useCallback(async () => {
    setMcpGenerating(true);
    try {
      await generateMcpApiKey();
    } catch (err) {
      console.error("Failed to generate API key:", err);
    } finally {
      setMcpGenerating(false);
    }
  }, [generateMcpApiKey]);

  const handleRevokeKey = useCallback(async () => {
    if (!window.confirm("Revoke your MCP API key? Any integrations using it will stop working.")) return;
    setMcpGenerating(true);
    try {
      await revokeMcpApiKey();
    } catch (err) {
      console.error("Failed to revoke API key:", err);
    } finally {
      setMcpGenerating(false);
    }
  }, [revokeMcpApiKey]);

  if (profile === undefined) {
    return (
      <div className="profile-page">
        <div className="profile-loading">Loading profile...</div>
      </div>
    );
  }

  return (
    <div className="profile-page">
      <div className="profile-header">
        <button className="profile-back" onClick={onClose} aria-label="Back to wardrobe">
          <ArrowLeft size={20} />
        </button>
        <h1 className="profile-title">Profile & Account</h1>
      </div>

      <div className="profile-content">
        {/* User Info Section */}
        <section className="profile-section">
          <h2 className="profile-section-heading">
            <User size={16} /> Account
          </h2>
          <div className="profile-field">
            <label>Name</label>
            {editingName !== null ? (
              <div className="profile-edit-row">
                <input
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  maxLength={120}
                  autoFocus
                  className="profile-input"
                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveName(); if (e.key === "Escape") setEditingName(null); }}
                />
                <button className="profile-save-btn" onClick={handleSaveName} disabled={saving || !editingName.trim()}>
                  <FloppyDisk size={16} />
                </button>
                <button className="profile-cancel-btn" onClick={() => setEditingName(null)}>Cancel</button>
              </div>
            ) : (
              <div className="profile-value-row">
                <span className="profile-value">{profile.name || "Add your name"}</span>
                <button className="profile-edit-btn" onClick={() => setEditingName(profile.name || "")}>Edit</button>
              </div>
            )}
            {saveError && <p className="profile-error"><WarningCircle size={14} /> {saveError}</p>}
          </div>
          <div className="profile-field">
            <label>Email</label>
            <span className="profile-value">{profile.email}</span>
          </div>
          <div className="profile-field">
            <label>Plan</label>
            <span className="profile-value profile-plan-badge">{profile.plan}</span>
          </div>
        </section>

        {/* MCP API Key Section */}
        <section className="profile-section">
          <h2 className="profile-section-heading">
            <Key size={16} /> MCP API Key
          </h2>
          <p className="profile-section-desc">
            Use this key to connect AI assistants (Claude, ChatGPT) to your wardrobe via the MCP server.
          </p>
          {mcpApiKey ? (
            <>
              <div className="profile-api-key-row">
                <code className="profile-api-key">{mcpApiKey}</code>
                <button
                  className="profile-copy-btn"
                  onClick={handleCopyKey}
                  title="Copy key"
                >
                  <Copy size={16} />
                  {mcpCopied ? "Copied!" : "Copy"}
                </button>
              </div>
              <div className="profile-api-key-actions">
                <button
                  className="profile-api-revoke-btn"
                  onClick={handleRevokeKey}
                  disabled={mcpGenerating}
                >
                  <Trash size={14} /> Revoke Key
                </button>
              </div>
            </>
          ) : (
            <button
              className="profile-api-generate-btn"
              onClick={handleGenerateKey}
              disabled={mcpGenerating}
            >
              <Key size={16} /> {mcpGenerating ? "Generating..." : "Generate API Key"}
            </button>
          )}
        </section>

        {/* Wardrobe Stats */}
        <section className="profile-section">
          <h2 className="profile-section-heading">Wardrobe</h2>
          <div className="profile-stats">
            <div className="profile-stat">
              <span className="profile-stat-num">{profile.wardrobeCount}</span>
              <span className="profile-stat-label">Items</span>
            </div>
            <div className="profile-stat">
              <span className="profile-stat-num">{profile.creditBalance}</span>
              <span className="profile-stat-label">Credits</span>
            </div>
          </div>
        </section>

        {/* Style Insights */}
        <section className="profile-section">
          <h2 className="profile-section-heading">Style Insights</h2>
          {profile.topColors.length > 0 && (
            <div className="profile-field">
              <label>Top Colors</label>
              <div className="profile-color-row">
                {profile.topColors.map(({ color, count }) => (
                  <span key={color} className="profile-color-chip" style={{ backgroundColor: color }} title={`${color} (${count})`} />
                ))}
              </div>
            </div>
          )}
          {profile.topTags.length > 0 && (
            <div className="profile-field">
              <label>Most Worn Tags</label>
              <div className="profile-tag-row">
                {profile.topTags.map(({ tag, count }) => (
                  <span key={tag} className="profile-tag">{tag} ({count})</span>
                ))}
              </div>
            </div>
          )}
          {Object.keys(profile.partDistribution).length > 0 && (
            <div className="profile-field">
              <label>Category Breakdown</label>
              <div className="profile-tag-row">
                {Object.entries(profile.partDistribution).map(([part, count]) => (
                  <span key={part} className="profile-tag">{part}: {count}</span>
                ))}
              </div>
            </div>
          )}
          {profile.topColors.length === 0 && (
            <p className="profile-empty">Add items to your wardrobe to see style insights.</p>
          )}
        </section>
      </div>
    </div>
  );
}
