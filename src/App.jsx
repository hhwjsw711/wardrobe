import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, ArrowsClockwise, Check, CoatHanger, MagnifyingGlass, Plus, SpinnerGap, Trash, UserFocus, X } from "@phosphor-icons/react";
import { useConvexAuth, useAuthActions } from "@convex-dev/auth/react";
import { useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { WardrobeImportFlow } from "./import-flow.jsx";
import { AuthForm } from "./AuthForm.jsx";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { useConvexWardrobe, useConvexOutfits, useConvexTryon, useConvexCredits } from "./hooks/useConvex.js";


const TYPES = [
  { id: "all", label: "All" },
  { id: "upperbody", label: "Tops", singular: "Top" },
  { id: "wholebody_up", label: "Jackets", singular: "Jacket" },
  { id: "lowerbody", label: "Bottoms", singular: "Bottom" },
  { id: "accessories_up", label: "Accessories", singular: "Accessory" },
  { id: "shoes", label: "Shoes", singular: "Shoes" },
  { id: "outfits", label: "Outfits" },
];

const TYPE_MAP = Object.fromEntries(TYPES.map((type) => [type.id, type]));
const TYPE_ORDER = Object.fromEntries(TYPES.slice(1).map((type, index) => [type.id, index]));

// Hex color validation — used to keep palette swatches sane. The vision
// pipeline occasionally emits literal "null"/"" for empty colors; without
// this filter those values would render as `style={{ backgroundColor: "null" }}`
// which the browser rejects and the label UI shows "null" as the selected value.
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
function isValidHex(value) {
  return typeof value === "string" && HEX_COLOR_RE.test(value);
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(first, second) {
  return Math.sqrt(
    ((first.red - second.red) ** 2)
    + ((first.green - second.green) ** 2)
    + ((first.blue - second.blue) ** 2),
  );
}

function extractPalette(image) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 72;
    canvas.height = 72;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const buckets = new Map();

    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3];
      if (alpha < 72) continue;

      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const key = `${Math.round(red / 28)}-${Math.round(green / 28)}-${Math.round(blue / 28)}`;
      const current = buckets.get(key) || { red: 0, green: 0, blue: 0, count: 0 };
      current.red += red;
      current.green += green;
      current.blue += blue;
      current.count += 1;
      buckets.set(key, current);
    }

    const ranked = [...buckets.values()]
      .map((bucket) => ({
        red: Math.round(bucket.red / bucket.count),
        green: Math.round(bucket.green / bucket.count),
        blue: Math.round(bucket.blue / bucket.count),
        count: bucket.count,
      }))
      .sort((a, b) => b.count - a.count);

    const selected = [];
    for (const color of ranked) {
      if (selected.every((existing) => colorDistance(existing, color) > 38)) selected.push(color);
      if (selected.length === 5) break;
    }

    return selected.map((color) => rgbToHex(color.red, color.green, color.blue));
  } catch (error) {
    // Cross-origin images without proper CORS headers taint the canvas and
    // throw a SecurityError on getImageData. Skip palette extraction in that
    // case rather than spamming the console.
    return [];
  }
}

function buildSamplingCanvas(image) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
    return canvas;
  } catch (error) {
    // Cross-origin tainted canvas; color sampling will be unavailable.
    return null;
  }
}

function sampleImageColor(image, canvas, event) {
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale;
  const renderedHeight = image.naturalHeight * scale;
  const offsetX = (bounds.width - renderedWidth) / 2;
  const offsetY = (bounds.height - renderedHeight) / 2;
  const imageX = Math.floor((event.clientX - bounds.left - offsetX) / scale);
  const imageY = Math.floor((event.clientY - bounds.top - offsetY) / scale);

  if (imageX < 0 || imageY < 0 || imageX >= canvas.width || imageY >= canvas.height) return null;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  try {
    for (let radius = 0; radius <= 18; radius += 2) {
      const startX = Math.max(0, imageX - radius);
      const startY = Math.max(0, imageY - radius);
      const width = Math.min(canvas.width - startX, (radius * 2) + 1);
      const height = Math.min(canvas.height - startY, (radius * 2) + 1);
      const data = context.getImageData(startX, startY, width, height).data;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index + 3] > 96) return rgbToHex(data[index], data[index + 1], data[index + 2]);
      }
    }
  } catch (error) {
    // Cross-origin tainted canvas; cannot sample pixel color.
    return null;
  }

  return null;
}

function GalleryItem({ item, selected, onOpen }) {
  const type = TYPE_MAP[item.part]?.singular || "wardrobe item";

  return (
    <button
      className={`gallery-item${selected ? " selected" : ""}`}
      type="button"
      onClick={() => onOpen(item.id)}
      aria-label={`View ${item.name || type}`}
      aria-pressed={selected}
      data-testid={`wardrobe-item-${item.id}`}
    >
      <OptimizedImage
        src={item.thumbnail || item.image}
        alt=""
        sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 180px"
        breakpoints={[120, 180, 240, 320, 480]}
      />
    </button>
  );
}

function TagEditor({ tags, onChange }) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const nextTag = input.trim().replace(/^#/, "");
    if (!nextTag || tags.some((tag) => tag.toLowerCase() === nextTag.toLowerCase())) return;
    onChange([...tags, nextTag]);
    setInput("");
  };

  return (
    <div className="tag-editor">
      <div className="editable-tags">
        {tags.map((tag) => (
          <span className="editable-tag" key={tag}>
            {tag}
            <button type="button" onClick={() => onChange(tags.filter((existing) => existing !== tag))} aria-label={`Remove ${tag}`}>
              <X size={12} weight="regular" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="tag-input-row">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addTag();
            }
          }}
          placeholder="Add a detail"
          aria-label="Add detail tag"
        />
        <button type="button" onClick={addTag} disabled={!input.trim()} aria-label="Add detail">
          <Plus size={15} weight="regular" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function ColorControl({ label, field, value, palette, onChange, sampling, setSampling, optional = false, onClear, onAdd }) {
  if (optional && !value) {
    return (
      <div className="color-slot empty-color-slot">
        <div className="color-slot-heading">
          <span>{label}</span>
          <small>Optional</small>
        </div>
        <p>No distinct secondary color detected.</p>
        <button className="add-secondary-button" type="button" onClick={onAdd}>Add secondary color</button>
      </div>
    );
  }

  // Defense-in-depth: drop any non-#rrggbb entries so the palette never
  // renders an unusable swatch. useConvex.js already sanitizes at mapping
  // time, but extractPalette is run client-side and could in theory return
  // something unexpected — this guarantees the UI stays valid.
  const safePalette = Array.isArray(palette) ? palette.filter(isValidHex) : [];
  const safeValue = isValidHex(value) ? value : (optional ? null : "#9a9286");

  return (
    <div className="color-slot">
      <div className="color-slot-heading">
        <span>{label}</span>
        {optional && <button type="button" onClick={onClear}>Remove</button>}
      </div>
      <label className="selected-color-control">
        <input
          type="color"
          value={safeValue || "#9a9286"}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`Choose ${label.toLowerCase()}`}
        />
        <span className="selected-color-copy">
          <small>Selected</small>
          <strong>{safeValue || "Custom"}</strong>
        </span>
      </label>
      <div className="suggestion-heading">
        <span>Image suggestions</span>
        <small>Click to apply</small>
      </div>
      <div className="palette" aria-label={`${label} suggestions from image`}>
        {safePalette.map((color) => (
          <button
            type="button"
            key={color}
            className={safeValue?.toLowerCase() === color.toLowerCase() ? "active" : ""}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
            aria-label={`Use ${color} as ${label.toLowerCase()}`}
            title={color}
          />
        ))}
      </div>
      <button
        className={`sample-button${sampling === field ? " active" : ""}`}
        type="button"
        onClick={() => setSampling((current) => current === field ? null : field)}
      >
        {sampling === field ? "Cancel picking" : `Pick ${label.toLowerCase()} from image`}
      </button>
    </div>
  );
}

function ItemEditor({ draft, setDraft, palette, sampling, setSampling, sampleStatus }) {
  const suggestedSecondary = palette.find((color) => color.toLowerCase() !== draft.color?.toLowerCase()) || "#9a9286";

  return (
    <div className="item-editor">
      <label className="field">
        <span>Name</span>
        <input
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder={TYPE_MAP[draft.part]?.singular || "Wardrobe item"}
        />
      </label>

      <label className="field">
        <span>Category</span>
        <select value={draft.part} onChange={(event) => setDraft((current) => ({ ...current, part: event.target.value }))}>
          {TYPES.slice(1).map((type) => <option value={type.id} key={type.id}>{type.label}</option>)}
        </select>
      </label>

      <fieldset className="color-field">
        <legend>Colors</legend>
        <div className="colors-editor">
          <ColorControl
            label="Primary color"
            field="primary"
            value={draft.color}
            palette={palette}
            onChange={(color) => setDraft((current) => ({ ...current, color }))}
            sampling={sampling}
            setSampling={setSampling}
          />
          <ColorControl
            label="Secondary color"
            field="secondary"
            value={draft.secondaryColor}
            palette={palette}
            onChange={(secondaryColor) => setDraft((current) => ({ ...current, secondaryColor }))}
            sampling={sampling}
            setSampling={setSampling}
            optional
            onClear={() => setDraft((current) => ({ ...current, secondaryColor: null }))}
            onAdd={() => setDraft((current) => ({ ...current, secondaryColor: suggestedSecondary }))}
          />
        </div>
        <p className="color-help" aria-live="polite">{sampling ? `Click anywhere on the garment to sample the ${sampling} color.` : sampleStatus || "Primary colors come from the image. A secondary is suggested only when a distinct color has meaningful coverage."}</p>
      </fieldset>

      <div className="field details-field">
        <span>Details</span>
        <TagEditor tags={draft.tags} onChange={(tags) => setDraft((current) => ({ ...current, tags }))} />
      </div>
    </div>
  );
}

function ItemViewer({ item, onClose, onSave, onDelete, onIdentifyProduct, onGenerateModeled }) {
  const closeButtonRef = useRef(null);
  const imageRef = useRef(null);
  const samplingCanvasRef = useRef(null);
  const shakeTimerRef = useRef(null);
  const [sampling, setSampling] = useState(null);
  const [sampleStatus, setSampleStatus] = useState("");
  const [palette, setPalette] = useState(item.palette || []);
  const [draft, setDraft] = useState({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  const [shaking, setShaking] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [matchingProduct, setMatchingProduct] = useState(false);
  const [generatingModeled, setGeneratingModeled] = useState(false);
  const type = TYPE_MAP[item.part]?.singular || "Wardrobe item";
  const hasModeledImage = Boolean(item.modeledImage);
  const pieceRotation = useMemo(() => {
    const hash = [...item.id].reduce((total, character) => total + character.charCodeAt(0), 0);
    return `${(hash % 9) - 4}deg`;
  }, [item.id]);

  const isDirty = useMemo(() => {
    const normalizedTags = (tags) => tags.map((tag) => tag.trim()).filter(Boolean);
    return JSON.stringify({
      name: draft.name.trim(),
      part: draft.part,
      color: draft.color?.toLowerCase() || null,
      secondaryColor: draft.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(draft.tags),
    }) !== JSON.stringify({
      name: (item.name || "").trim(),
      part: item.part,
      color: item.color?.toLowerCase() || null,
      secondaryColor: item.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(item.tags || []),
    });
  }, [draft, item]);

  const nudgeUnsaved = useCallback(() => {
    setCloseBlocked(true);
    setShaking(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShaking(true));
    });
    clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => setShaking(false), 420);
  }, []);

  const requestClose = useCallback(() => {
    if (isDirty) nudgeUnsaved();
    else onClose();
  }, [isDirty, nudgeUnsaved, onClose]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        if (sampling) setSampling(null);
        else requestClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("viewer-open");
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
      clearTimeout(shakeTimerRef.current);
    };
  }, [requestClose, sampling]);

  useEffect(() => {
    if (!isDirty) setCloseBlocked(false);
  }, [isDirty]);

  useEffect(() => {
    setSampling(null);
    setSampleStatus("");
    setActionError("");
    setConfirmingDelete(false);
    setMatchingProduct(false);
    setGeneratingModeled(false);
    setPalette(item.palette || []);
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  }, [item]);

  const cancelEditing = () => {
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
    setSampling(null);
    setSampleStatus("");
    onClose();
  };

  const saveEditing = async () => {
    setSaving(true);
    setActionError("");
    try {
      const saved = await onSave({ ...item, ...draft, name: draft.name.trim(), tags: draft.tags.map((tag) => tag.trim()).filter(Boolean) });
      setDraft({ name: saved.name || "", part: saved.part, color: saved.color || "#9a9286", secondaryColor: saved.secondaryColor || null, tags: [...(saved.tags || [])] });
      setSampling(null);
      setSampleStatus("Saved to your wardrobe.");
    } catch (error) {
      setActionError(error.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteItem = async () => {
    setSaving(true);
    setActionError("");
    try {
      await onDelete(item.id);
    } catch (error) {
      setActionError(error.message);
      setConfirmingDelete(false);
    } finally {
      setSaving(false);
    }
  };

  const identifyProduct = async () => {
    setMatchingProduct(true);
    setActionError("");
    try {
      const matched = await onIdentifyProduct(item.id);
      setDraft({ name: matched.name || "", part: matched.part, color: matched.color || "#9a9286", secondaryColor: matched.secondaryColor || null, tags: [...(matched.tags || [])] });
      setSampleStatus(matched.productConfidence === "exact" ? "Exact product match saved." : matched.productConfidence === "likely" ? "Possible product match saved with its source." : "No exact product match was supported by the photo.");
    } catch (error) {
      setActionError(error.message);
    } finally {
      setMatchingProduct(false);
    }
  };

  const generateModeled = async () => {
    setGeneratingModeled(true);
    setActionError("");
    try {
      await onGenerateModeled(item.id);
      setSampleStatus("Modeled photo generated. It will appear above shortly.");
    } catch (error) {
      setActionError(error.message);
    } finally {
      setGeneratingModeled(false);
    }
  };

  const handleImageLoad = (event) => {
    samplingCanvasRef.current = buildSamplingCanvas(event.currentTarget);
    const extracted = extractPalette(event.currentTarget);
    setPalette([...new Set([...(item.palette || []), ...extracted])].slice(0, 5));
  };

  const handleImageClick = (event) => {
    if (!sampling || !samplingCanvasRef.current) return;
    const color = sampleImageColor(event.currentTarget, samplingCanvasRef.current, event);
    if (!color) {
      setSampleStatus("That spot is transparent—try directly on the garment.");
      return;
    }
    const targetField = sampling === "secondary" ? "secondaryColor" : "color";
    setDraft((current) => ({ ...current, [targetField]: color }));
    setPalette((current) => [color, ...current.filter((existing) => existing.toLowerCase() !== color.toLowerCase())].slice(0, 5));
    setSampleStatus(`Sampled ${color} as the ${sampling} color.`);
    setSampling(null);
  };

  const garmentArtwork = (
    <div
      className={`viewer-art${hasModeledImage ? " viewer-art-floating" : ""}${sampling ? " sampling" : ""}`}
      style={hasModeledImage ? { "--piece-rotation": pieceRotation } : undefined}
    >
      <OptimizedImage
        ref={imageRef}
        src={item.image}
        alt={`Selected ${type.toLowerCase()}`}
        sizes="(max-width: 520px) 40vw, 300px"
        breakpoints={[160, 240, 320, 480, 640]}
        priority
        crossOrigin="anonymous"
        onLoad={handleImageLoad}
        onClick={handleImageClick}
      />
      {sampling && <span className="sample-hint">Click garment to sample</span>}
    </div>
  );

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
    <div className="viewer-entry">
    <aside className={`viewer editing${hasModeledImage ? " has-modeled-image" : ""}${shaking ? " shake" : ""}`} role="dialog" aria-modal="true" aria-label="Selected wardrobe item">
      <button className="viewer-icon-close" type="button" onClick={requestClose} aria-label="Close viewer" ref={closeButtonRef}>
        <X size={24} weight="light" aria-hidden="true" />
      </button>

      {hasModeledImage ? (
        <div className="modeled-hero">
          <OptimizedImage
            className="modeled-hero-photo"
            src={item.modeledImage}
            alt={`${draft.name || type} worn by a model`}
            sizes="(max-width: 860px) 100vw, 520px"
            breakpoints={[320, 480, 640, 800, 1040, 1280]}
            quality={82}
            priority
          />
          <div className="viewer-heading modeled-heading">
            <div>
              <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
            </div>
          </div>
          {garmentArtwork}
        </div>
      ) : (
        <>
          <div className="viewer-heading">
            <div>
              <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
            </div>
          </div>
          {garmentArtwork}
        </>
      )}

      <div className="viewer-details editing">
        <ItemEditor
          draft={draft}
          setDraft={setDraft}
          palette={palette}
          sampling={sampling}
          setSampling={setSampling}
          sampleStatus={sampleStatus}
        />

        <section className="product-evidence" aria-label="Modeled photo">
          <div className="product-evidence__heading"><div><span>Modeled photo</span><strong>{hasModeledImage ? "Photo ready" : "Not generated yet"}</strong></div></div>
          {!hasModeledImage && <p>Creates a photo of you wearing this piece using your reference photos.</p>}
          <div className="product-evidence__actions">
            <button type="button" onClick={generateModeled} disabled={saving || generatingModeled || isDirty} title={isDirty ? "Save your edits before generating" : undefined}>{generatingModeled ? <SpinnerGap size={14} className="product-match-spinner" /> : <UserFocus size={14} />} {generatingModeled ? "Generating..." : hasModeledImage ? "Regenerate photo" : "Generate modeled photo"}</button>
          </div>
        </section>

        <section className="product-evidence" aria-label="Product identification">
          <div className="product-evidence__heading"><div><span>Product match</span><strong>{item.productName ? [item.brand, item.productName].filter(Boolean).join(" ") : "Not identified yet"}</strong></div>{item.productConfidence && item.productConfidence !== "unknown" && <em data-confidence={item.productConfidence}>{item.productConfidence === "exact" ? "Exact" : "Possible"}</em>}</div>
          {item.productColorway && <p>Colorway: {item.productColorway}</p>}
          {item.productMatchSummary && <p>{item.productMatchSummary}</p>}
          {!!item.productEvidence?.length && <ul>{item.productEvidence.slice(0, 3).map((evidence) => <li key={evidence}>{evidence}</li>)}</ul>}
          <div className="product-evidence__actions">
            <button type="button" onClick={identifyProduct} disabled={saving || matchingProduct || isDirty} title={isDirty ? "Save your edits before checking the product" : undefined}>{matchingProduct ? <SpinnerGap size={14} className="product-match-spinner" /> : <MagnifyingGlass size={14} />} {matchingProduct ? "Checking product" : item.productName ? "Check again" : "Identify product"}</button>
            {item.productUrl && <a href={item.productUrl} target="_blank" rel="noreferrer">View source <ArrowSquareOut size={13} /></a>}
          </div>
        </section>

        {closeBlocked && <p className="unsaved-notice" role="status">Save or cancel changes before closing.</p>}
        {actionError && <p className="viewer-action-error" role="alert">{actionError}</p>}

        <div className="viewer-actions">
          {confirmingDelete ? (
            <div className="delete-confirmation">
              <span>Delete this piece?</span>
              <button className="delete-button" type="button" onClick={deleteItem} disabled={saving}>Delete</button>
              <button className="secondary-button" type="button" onClick={() => setConfirmingDelete(false)} disabled={saving}>Keep</button>
            </div>
          ) : (
            <button className="delete-button" type="button" onClick={() => setConfirmingDelete(true)} disabled={saving}>
              <Trash size={15} weight="regular" aria-hidden="true" /> Delete
            </button>
          )}
          <span className="action-spacer" />
          <button className="secondary-button" type="button" onClick={cancelEditing} disabled={saving}>Cancel</button>
          <button className="primary-button" type="button" onClick={saveEditing} disabled={saving || !draft.name.trim()}>
            <Check size={15} weight="bold" aria-hidden="true" /> {saving ? "Saving" : "Save"}
          </button>
        </div>
      </div>
    </aside>
    </div>
    </div>
  );
}

const OUTFIT_SLOTS = {
  // tops: alternate left/right across the top of the card
  upperbody: [
    { top: "4%", left: "5%", maxH: "56%", maxW: "44%", rot: -5 },
    { top: "4%", right: "5%", maxH: "56%", maxW: "44%", rot: 5 },
  ],
  wholebody_up: [
    { top: "4%", left: "5%", maxH: "56%", maxW: "44%", rot: -5 },
    { top: "4%", right: "5%", maxH: "56%", maxW: "44%", rot: 5 },
  ],
  // bottoms: alternate right/left across the bottom (taller, keep natural proportion)
  lowerbody: [
    { bottom: "3%", right: "5%", maxH: "58%", maxW: "44%", rot: 5 },
    { bottom: "3%", left: "5%", maxH: "58%", maxW: "44%", rot: -5 },
  ],
  // shoes: bottom-left, smaller
  shoes: [
    { bottom: "6%", left: "10%", maxH: "26%", maxW: "34%", rot: -3 },
    { bottom: "6%", right: "10%", maxH: "26%", maxW: "34%", rot: 3 },
  ],
  // accessories: top-right, smaller
  accessories_up: [
    { top: "6%", right: "7%", maxH: "30%", maxW: "32%", rot: 6 },
    { top: "6%", left: "7%", maxH: "30%", maxW: "32%", rot: -6 },
  ],
};

function slotForGarment(part, indexAmongPart) {
  const slots = OUTFIT_SLOTS[part] || OUTFIT_SLOTS.upperbody;
  return slots[indexAmongPart % slots.length];
}

// When more pieces of a part exist than predefined slots (3+ tops, etc.),
// apply a deterministic pseudo-random jitter on top of the base slot so the
// overflow pieces don't land on exactly the same spot as piece 0/1.
// Same outfit+garment → same jitter every render (no flicker on re-render).
function jitteredSlot(part, indexAmongPart, outfitId, garmentId) {
  const base = slotForGarment(part, indexAmongPart);
  const slots = OUTFIT_SLOTS[part] || OUTFIT_SLOTS.upperbody;
  // Only jitter when we're past the predefined slot count.
  if (indexAmongPart < slots.length) return base;

  const r1 = hash01(`${outfitId}:${garmentId}:jx`);
  const r2 = hash01(`${outfitId}:${garmentId}:jy`);
  const r3 = hash01(`${outfitId}:${garmentId}:jr`);

  const clone = { ...base };
  // Shift ±3%..±8% horizontally, ±2.5%..±5% vertically, ±3°..±6° rotation.
  const dx = (r1 - 0.5) * 16; // -8..+8
  const dy = (r2 - 0.5) * 10; // -5..+5
  const dr = (r3 - 0.5) * 12; // -6..+6 deg

  if (clone.top != null) clone.top = `${parseFloat(clone.top) + dy}%`;
  if (clone.bottom != null) clone.bottom = `${parseFloat(clone.bottom) - dy}%`;
  if (clone.left != null) clone.left = `${parseFloat(clone.left) + dx}%`;
  if (clone.right != null) clone.right = `${parseFloat(clone.right) - dx}%`;
  clone.rot = (clone.rot || 0) + dr;
  // Make overflow pieces slightly smaller so they read as "secondary".
  clone.maxH = `${parseFloat(clone.maxH) * 0.8}%`;
  clone.maxW = `${parseFloat(clone.maxW) * 0.8}%`;
  return clone;
}

// Deterministic hash → [0,1). Used to scatter garment pieces in the viewer
// with a stable flat-lay feel (same outfit → same scatter every open).
function hash01(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

// Group garments by their `part` while preserving first-appearance order.
// Each group becomes one horizontal row in the outfit viewer so that e.g.
// two tops sit side-by-side and a pair of bottoms gets its own row below.
function groupGarmentsByPart(garments) {
  const groups = [];
  const index = new Map();
  for (const g of garments) {
    const part = g.part || "upperbody";
    let group = index.get(part);
    if (!group) {
      group = { part, items: [] };
      index.set(part, group);
      groups.push(group);
    }
    group.items.push(g);
  }
  return groups;
}

// Vertical flat-lay scatter for single-piece groups (1 top + 1 bottom case).
// Outward tilt + zig-zag drift + small upward overlap on subsequent pieces →
// loose flat-lay that reads as "随手摆放" instead of aligned stack.
// Same outfit+garment → same scatter every render (no flicker).
function pieceScatter(outfitId, garmentId, index) {
  const r1 = hash01(`${outfitId}:${garmentId}:x`);
  const r2 = hash01(`${outfitId}:${garmentId}:r`);
  const r3 = hash01(`${outfitId}:${garmentId}:y`);
  const side = index % 2 === 0 ? 1 : -1; // even → right, odd → left
  const xPct = side * (8 + r1 * 7);      // ±8%..±15%
  const rotDeg = side * (3 + r2 * 4);    // ±3°..±7°, tilting outward
  const yPct = index === 0 ? 0 : -(4 + r3 * 6); // subsequent pieces overlap upward 4%..10%
  return { xPct, rotDeg, yPct };
}

// Horizontal layout for multi-piece groups (2+ tops side-by-side case).
// Returns { xPct, rotDeg, yPct } consumed as CSS custom properties on
// `.outfit-viewer-piece`. Even pieces drift down-right, odd pieces drift
// up-left, both with INWARD tilt (tops lean toward center → reads as two
// garments casually drooping onto each other). 3rd+ pieces add x/y jitter
// so they don't pile on top of idx 0/1.
// Piece size stays identical to single-piece groups — no shrinking.
// Pieces overlap in the middle — flat-lay feel where garment edges naturally
// drape over each other. Diagonal y offsets the silhouettes so the overlap
// still reads as two distinct pieces.
function rowLayout(totalInRow, idxAmongPart, outfitId, garmentId) {
  const side = idxAmongPart % 2 === 0 ? -1 : 1; // even → left-side var, odd → right-side var
  const rx = hash01(`${outfitId}:${garmentId}:rx`);
  const rr = hash01(`${outfitId}:${garmentId}:rr`);
  const ry = hash01(`${outfitId}:${garmentId}:ry`);
  // 3rd+ piece in the same row: add x/y jitter so it doesn't land on idx 0/1.
  if (idxAmongPart >= 2) {
    const jx = hash01(`${outfitId}:${garmentId}:jx`);
    const jy = hash01(`${outfitId}:${garmentId}:jy`);
    // Pick a side based on parity, then scatter wider than the base pair.
    const jside = idxAmongPart % 2 === 0 ? 1 : -1;
    const xPct = jside * (10 + jx * 6);         // ±10%..±16% pushed outward
    const rotDeg = jside * (4 + rr * 4);        // ±4°..±8° matching base tilt direction
    const yPct = (jy - 0.5) * 14;               // ±7% vertical scatter
    return { xPct, rotDeg, yPct };
  }
  // Negative x → pieces move INWARD and overlap at center. Flat-lay drape.
  const xPct = side * -(7 + rx * 4);           // ∓7%..∓11% inward overlap (idx 0 → right, idx 1 → left)
  const rotDeg = side * (4 + rr * 4);          // ±4°..±8° inward tilt (tops lean toward center)
  // Diagonal flat-lay: even drifts down, odd drifts up — silhouettes offset.
  const yDir = idxAmongPart % 2 === 0 ? 1 : -1;
  const yPct = yDir * (3 + ry * 4);            // ±3%..±7% diagonal lift/drop
  return { xPct, rotDeg, yPct };
}

function OutfitGalleryItem({ outfit, onOpen }) {
  const garments = outfit.garments || [];
  const partCounts = {};

  return (
    <button
      className="outfit-gallery-item"
      type="button"
      onClick={() => onOpen(outfit.id)}
      aria-label={`View outfit ${outfit.name}`}
    >
      {outfit.status === "ready" && outfit.image ? (
        <>
          <img className="outfit-photo" src={outfit.image} alt={outfit.name} />
          {garments.length > 0 && (
            <div className="outfit-garments-overlay">
              {garments.map((garment) => {
                const part = garment.part || "upperbody";
                const idx = (partCounts[part] = (partCounts[part] || 0) + 1) - 1;
                const slot = jitteredSlot(part, idx, outfit.id, garment.id);
                const style = {
                  "--rot": `${slot.rot}deg`,
                  maxHeight: slot.maxH,
                  maxWidth: slot.maxW,
                };
                if (slot.top != null) style.top = slot.top;
                if (slot.bottom != null) style.bottom = slot.bottom;
                if (slot.left != null) style.left = slot.left;
                if (slot.right != null) style.right = slot.right;
                return (
                  <img
                    key={garment.id}
                    className="outfit-garment-cutout"
                    src={garment.thumbnail || garment.image}
                    alt=""
                    style={style}
                  />
                );
              })}
            </div>
          )}
        </>
      ) : (
        <div className="outfit-placeholder">
          {outfit.status === "generating" ? (
            <>
              <div className="outfit-spinner" />
              <span>Generating</span>
            </>
          ) : outfit.status === "failed" ? (
            <span className="outfit-error-icon">Failed</span>
          ) : outfit.status === "stalled" ? (
            <span className="outfit-error-icon">Interrupted</span>
          ) : (
            <CoatHanger size={32} weight="light" aria-hidden="true" />
          )}
        </div>
      )}
    </button>
  );
}

function OutfitViewer({ outfit, lookNumber, onClose, onDelete, onRegenerate, tryonJobs, onTryOn }) {
  const closeButtonRef = useRef(null);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("viewer-open");
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
    };
  }, [onClose]);

  const garments = outfit.garments || [];
  const lookLabel = Number.isInteger(lookNumber) && lookNumber > 0
    ? `LOOK ${String(lookNumber).padStart(2, "0")}`
    : null;

  // Try-on state — pulled from the real-time job list.
  // jobs come back newest-first (getTryonJobs uses `.order("desc")`).
  const latestTryon = tryonJobs && tryonJobs.length > 0 ? tryonJobs[0] : null;
  const tryonInProgress =
    latestTryon && (latestTryon.status === "pending" || latestTryon.status === "processing");

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="viewer-entry">
        <aside className="viewer outfit-viewer" role="dialog" aria-modal="true" aria-label={`Outfit ${outfit.name}`}>
          <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="Close viewer" ref={closeButtonRef}>
            <X size={24} weight="light" aria-hidden="true" />
          </button>

          {lookLabel && <div className="outfit-look-number">{lookLabel}</div>}

          <div className="outfit-viewer-photo">
            {outfit.status === "ready" && outfit.image ? (
              <img
                className="outfit-viewer-photo-image"
                src={outfit.image}
                alt={outfit.name}
                crossOrigin="anonymous"
              />
            ) : outfit.status === "failed" || outfit.status === "stalled" ? (
              <div className="outfit-viewer-photo-placeholder">
                <CoatHanger size={36} weight="light" aria-hidden="true" />
                <span>Could not generate this outfit.</span>
              </div>
            ) : (
              <div className="outfit-viewer-photo-placeholder">
                <SpinnerGap size={28} weight="bold" className="spin" aria-hidden="true" />
                <span>Generating outfit…</span>
              </div>
            )}
          </div>

          <div className="outfit-viewer-pieces-label">What&apos;s in this look</div>
          <div className="outfit-viewer-pieces">
            {garments.length > 0 ? (
              (() => {
                const groups = groupGarmentsByPart(garments);
                let singleIdx = 0; // running index for single-piece groups (pieceScatter)
                return groups.map((group) => {
                  if (group.items.length === 1) {
                    // Single-piece group → vertical flat-lay scatter (original feel).
                    const garment = group.items[0];
                    const i = singleIdx++;
                    const { xPct, rotDeg, yPct } = pieceScatter(outfit.id, garment.id, i);
                    return (
                      <div
                        className="outfit-viewer-piece"
                        key={garment.id}
                        style={{
                          "--piece-x": `${xPct}%`,
                          "--piece-rot": `${rotDeg}deg`,
                          "--piece-y": `${yPct}%`,
                        }}
                      >
                        <OptimizedImage
                          src={garment.thumbnail || garment.image}
                          alt={garment.name}
                          sizes="(max-width: 860px) 100vw, 440px"
                          breakpoints={[200, 320, 440, 560]}
                          quality={88}
                        />
                      </div>
                    );
                  }
                  // Multi-piece group → horizontal row, same piece size as single.
                  return (
                    <div
                      className="outfit-viewer-row"
                      key={group.part}
                    >
                      {group.items.map((garment, idx) => {
                        const { xPct, rotDeg, yPct } = rowLayout(
                          group.items.length,
                          idx,
                          outfit.id,
                          garment.id
                        );
                        return (
                          <div
                            className="outfit-viewer-piece"
                            key={garment.id}
                            style={{
                              "--piece-x": `${xPct}%`,
                              "--piece-rot": `${rotDeg}deg`,
                              "--piece-y": `${yPct}%`,
                            }}
                          >
                            <OptimizedImage
                              src={garment.thumbnail || garment.image}
                              alt={garment.name}
                              sizes="(max-width: 860px) 100vw, 440px"
                              breakpoints={[200, 320, 440, 560]}
                              quality={88}
                            />
                          </div>
                        );
                      })}
                    </div>
                  );
                });
              })()
            ) : (
              <div className="outfit-placeholder large">
                <CoatHanger size={48} weight="light" aria-hidden="true" />
              </div>
            )}
          </div>

          {latestTryon && (
            <div className="outfit-viewer-tryon">
              {latestTryon.status === "done" && latestTryon.imageUrl ? (
                <>
                  <div className="outfit-viewer-tryon-label">Try-on result</div>
                  <img
                    className="outfit-viewer-tryon-image"
                    src={latestTryon.imageUrl}
                    alt={`Try-on of ${outfit.name}`}
                  />
                </>
              ) : latestTryon.status === "failed" ? (
                <div className="outfit-viewer-tryon-failed">
                  <span>Try-on failed: {latestTryon.error || "Unknown error"}</span>
                </div>
              ) : (
                <div className="outfit-viewer-tryon-loading">
                  <SpinnerGap size={20} weight="bold" className="spin" aria-hidden="true" />
                  <span>Generating try-on image…</span>
                </div>
              )}
            </div>
          )}

          <div className="viewer-details outfit-viewer-details">
            <div className="outfit-viewer-meta">
              <h2 className="outfit-viewer-name">{outfit.name}</h2>
              {outfit.description && <p className="outfit-viewer-description">{outfit.description}</p>}
              {Array.isArray(outfit.tags) && outfit.tags.length > 0 && (
                <div className="outfit-viewer-tags">
                  {outfit.tags.map((tag) => (
                    <span className="outfit-viewer-tag" key={tag}>{tag}</span>
                  ))}
                </div>
              )}
            </div>

            <div className="viewer-actions outfit-viewer-actions">
              <button className="viewer-quiet-button" type="button" onClick={() => onDelete(outfit.id)} aria-label="Delete outfit">
                <Trash size={15} weight="regular" aria-hidden="true" />
              </button>
              {outfit.status === "ready" && (
                <button className="viewer-quiet-button" type="button" onClick={() => onRegenerate(outfit.id)} aria-label="Regenerate outfit">
                  <ArrowsClockwise size={15} weight="regular" aria-hidden="true" />
                </button>
              )}
              {outfit.status === "ready" && (
                <button
                  className="secondary-button tryon-button"
                  type="button"
                  onClick={() => onTryOn()}
                  disabled={tryonInProgress}
                  aria-label="Start virtual try-on (experimental, free)"
                >
                  {tryonInProgress ? (
                    <>
                      <SpinnerGap size={14} weight="bold" className="spin" aria-hidden="true" />
                      Generating…
                    </>
                  ) : (
                    "Try On (Experimental)"
                  )}
                </button>
              )}
              {outfit.status === "failed" && (
                <button className="secondary-button" type="button" onClick={() => onRegenerate(outfit.id)}>
                  <ArrowsClockwise size={15} weight="bold" aria-hidden="true" /> Retry
                </button>
              )}
              {outfit.status === "stalled" && (
                <button className="secondary-button" type="button" onClick={() => onRegenerate(outfit.id)}>
                  <ArrowsClockwise size={15} weight="bold" aria-hidden="true" /> Retry
                </button>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function OutfitCreator({ items, onCancel, onCreate }) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState([]);

  const toggle = (id) => {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((s) => s !== id)
        : current.length >= 6
          ? current
          : [...current, id]
    );
  };

  const canCreate = selected.length >= 2;

  const handleSubmit = () => {
    if (!canCreate) return;
    onCreate({ name: name.trim() || "New Outfit", garmentIds: selected });
  };

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="viewer-entry">
        <aside className="viewer outfit-creator" role="dialog" aria-modal="true" aria-label="Create outfit">
          <button className="viewer-icon-close" type="button" onClick={onCancel} aria-label="Close">
            <X size={24} weight="light" aria-hidden="true" />
          </button>

          <div className="viewer-heading">
            <div>
              <h2>Create Outfit</h2>
            </div>
          </div>

          <div className="viewer-details">
            <label className="field">
              <span>Outfit name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Weekend Casual"
                onKeyDown={(event) => event.key === "Enter" && canCreate && handleSubmit()}
              />
            </label>

            <div className="outfit-creator-info">
              <span>Selected: {selected.length}/6</span>
              <small>Pick 2-6 pieces to compose a look</small>
            </div>

            <div className="outfit-creator-grid">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`outfit-creator-item${selected.includes(item.id) ? " selected" : ""}`}
                  onClick={() => toggle(item.id)}
                  aria-pressed={selected.includes(item.id)}
                >
                  <OptimizedImage
                    src={item.thumbnail || item.image}
                    alt={item.name}
                    sizes="100px"
                    breakpoints={[80, 120]}
                  />
                  <span className="outfit-creator-item-name">{item.name}</span>
                  {selected.includes(item.id) && (
                    <span className="outfit-creator-check">
                      <Check size={14} weight="bold" aria-hidden="true" />
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="viewer-actions">
              <span className="action-spacer" />
              <button className="secondary-button" type="button" onClick={onCancel}>Cancel</button>
              <button
                className="primary-button"
                type="button"
                onClick={handleSubmit}
                disabled={!canCreate}
              >
                <Plus size={15} weight="bold" aria-hidden="true" /> Generate
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function App() {
  // ── Auth gate ──
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const { signOut } = useAuthActions();
  const provisionUser = useMutation(api.helpers.provisionUser);

  // Persist app-level user defaults (plan, creditBalance) once per
  // authenticated session. Idempotent on the backend; we additionally
  // guard with a ref so the effect fires at most once even if the
  // mutation function reference or auth state fluctuates between
  // renders (avoids Maximum update depth exceeded loops).
  const provisionedRef = useRef(false);
  useEffect(() => {
    if (!isAuthenticated || provisionedRef.current) return;
    provisionedRef.current = true;
    provisionUser().catch((err) => {
      // Reset on failure so a subsequent auth transition can retry.
      provisionedRef.current = false;
      console.warn("[provisionUser] failed:", err?.message ?? err);
    });
  }, [isAuthenticated, provisionUser]);

  // NOTE: do NOT early-return <AuthForm /> before all hooks below have
  // run. Returning early changes the number of hooks between renders
  // (Rules of Hooks violation). The auth gate is applied after all
  // hooks have executed, just before the JSX return.

  // ── Convex-backed data ──
  const wardrobe = useConvexWardrobe();
  const outfitsHook = useConvexOutfits();
  const creditsHook = useConvexCredits();

  const items = wardrobe.items;
  const loading = wardrobe.loading;
  const outfits = outfitsHook.outfits;
  const outfitsLoading = outfitsHook.loading;

  // ── UI state ──
  const [activeType, setActiveType] = useState(() => {
    if (typeof window === "undefined") return "all";
    const hash = window.location.hash.slice(1);
    return TYPES.some((t) => t.id === hash) ? hash : "all";
  });
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState("");
  const [selectedOutfitId, setSelectedOutfitId] = useState(null);
  const [showCreator, setShowCreator] = useState(false);

  // Stable callbacks for ItemViewer/OutfitViewer — prevents focus-stealing
  // and effect re-runs caused by inline arrow functions on every render.
  const handleCloseItem = useCallback(() => setSelectedId(null), []);
  const handleCloseOutfit = useCallback(() => setSelectedOutfitId(null), []);
  const handleCloseCreator = useCallback(() => setShowCreator(false), []);

  // Try-on jobs for the currently-selected outfit (real-time, skipped
  // when nothing is selected). Bound to selectedOutfitId so the viewer
  // can render pending → processing → done/failed transitions live.
  const tryonHook = useConvexTryon(selectedOutfitId);

  // Connection status derived from Convex loading state
  const connection = loading ? "connecting" : "connected";

  // Ref for latest items (used in identifyProduct + import bridge)
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // ── Derived data ──
  // No more loadWardrobe / loadOutfits / sync timer / polling —
  // Convex real-time subscriptions handle everything.

  const selectedItem = items.find((item) => item.id === selectedId) || null;

  const visibleItems = useMemo(() => {
    const filtered = activeType === "all" ? items : items.filter((item) => item.part === activeType);
    return [...filtered].sort((a, b) => {
      if (activeType === "all") {
        const typeDifference = (TYPE_ORDER[a.part] ?? 99) - (TYPE_ORDER[b.part] ?? 99);
        if (typeDifference) return typeDifference;
      }
      return a.id.localeCompare(b.id);
    });
  }, [activeType, items]);

  const chooseType = (typeId) => {
    setActiveType(typeId);
    setSelectedId(null);
    if (typeof window !== "undefined") window.location.hash = typeId;
  };

  // ── Wardrobe actions ──

  const saveItem = async (updatedItem) => {
    try {
      await wardrobe.saveItem(updatedItem.id, {
        name: updatedItem.name,
        part: updatedItem.part,
        color: updatedItem.color,
        secondaryColor: updatedItem.secondaryColor,
        tags: updatedItem.tags,
      });
      return updatedItem; // Return for ItemViewer draft reset
    } catch (requestError) {
      throw new Error(requestError.message || "Could not save this piece.");
    }
  };

  const deleteItem = async (id) => {
    try {
      await wardrobe.deleteItem(id);
    } catch (requestError) {
      throw new Error(requestError.message || "Could not delete this piece.");
    }
    setSelectedId(null);
  };

  const identifyProduct = async (id) => {
    try {
      const result = await wardrobe.identifyProduct(id);
      // Combine product match result with current item data
      const currentItem = itemsRef.current.find((i) => i.id === id);
      return currentItem ? { ...currentItem, ...result } : result;
    } catch (requestError) {
      throw new Error(requestError.message || "Could not identify this product.");
    }
  };

  const generateModeled = async (id) => {
    try {
      await wardrobe.generateModeled(id);
    } catch (requestError) {
      throw new Error(requestError.message || "Could not generate modeled photo.");
    }
  };

  // ── Outfit actions ──
  // Convex real-time subscriptions replace loadOutfits + polling entirely.

  const createOutfit = async ({ name, garmentIds }) => {
    try {
      await outfitsHook.createOutfit({ name, garmentIds });
      setShowCreator(false);
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteOutfit = async (id) => {
    try {
      await outfitsHook.deleteOutfit(id);
    } catch (err) {
      setError(err.message);
      return;
    }
    setSelectedOutfitId(null);
  };

  const regenerateOutfit = async (id) => {
    try {
      await outfitsHook.regenerateOutfit(id);
    } catch (err) {
      setError(err.message);
    }
  };

  const selectedOutfit = outfits.find((o) => o.id === selectedOutfitId) || null;

  const isOutfitsView = activeType === "outfits";

  // Auth gate: all hooks above have run, safe to short-circuit the JSX.
  if (!isAuthenticated) return <AuthForm />;

  return (
    <div className={`app-shell${selectedItem || selectedOutfit ? " has-selection" : ""}`}>
      <main className="gallery-pane">
        <header className="gallery-header">
          <div className="gallery-meta-row">
            <div className="gallery-title">
              <p>Private collection</p>
              <h1>My wardrobe</h1>
            </div>
            <div className="gallery-status">
              <p className={`connection-status is-${connection}`}>
                <span aria-hidden="true" />
                {connection === "connected" ? "Cloud synced" : "Connecting"}
              </p>
              <p className="piece-count">
                {isOutfitsView
                  ? `${outfits.length} ${outfits.length === 1 ? "outfit" : "outfits"}`
                  : `${items.length} ${items.length === 1 ? "piece" : "pieces"}`}
              </p>
              {!creditsHook.loading && creditsHook.balance.balance > 0 && (
                <p className="credit-balance">{creditsHook.balance.balance} credits</p>
              )}
              <button className="sign-out-button" type="button" onClick={() => signOut()} aria-label="Sign out">Sign out</button>
            </div>
          </div>
          <nav className="category-nav" aria-label="Filter wardrobe by item type">
            {TYPES.map((type) => (
              <button
                key={type.id}
                type="button"
                className={`${activeType === type.id ? "active" : ""}${type.id === "outfits" ? " outfits-tab" : ""}`}
                onClick={() => chooseType(type.id)}
                aria-pressed={activeType === type.id}
              >
                {type.label}
              </button>
            ))}
          </nav>
        </header>

        {error && <p className="status error">{error}</p>}

        {isOutfitsView ? (
          <>
            {!error && outfitsLoading && <p className="status">Loading outfits</p>}
            {!error && !outfitsLoading && !outfits.length && (
              <p className="status empty">No outfits yet. Tap + to compose a look.</p>
            )}

            {!!outfits.length && (
              <section className="gallery-grid outfit-grid" aria-label="Outfit gallery">
                {outfits.map((outfit) => (
                  <OutfitGalleryItem
                    key={outfit.id}
                    outfit={outfit}
                    onOpen={setSelectedOutfitId}
                  />
                ))}
              </section>
            )}
          </>
        ) : (
          <>
            {!error && loading && <p className="status">Loading wardrobe</p>}
            {!error && !loading && !items.length && <p className="status empty">Tap "Add clothes" and choose a photo to start your wardrobe.</p>}

            {!!items.length && (
              <section className="gallery-grid" aria-label={`${TYPE_MAP[activeType]?.label || "All"} wardrobe items`}>
                {visibleItems.map((item) => (
                  <GalleryItem
                    key={item.id}
                    item={item}
                    selected={selectedId === item.id}
                    onOpen={setSelectedId}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </main>

      {selectedItem && <ItemViewer item={selectedItem} onClose={handleCloseItem} onSave={saveItem} onDelete={deleteItem} onIdentifyProduct={identifyProduct} onGenerateModeled={generateModeled} />}
      {selectedOutfit && (
        <OutfitViewer
          outfit={selectedOutfit}
          lookNumber={
            [...outfits]
              .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))
              .findIndex((o) => o.id === selectedOutfit.id) + 1
          }
          onClose={handleCloseOutfit}
          onDelete={deleteOutfit}
          onRegenerate={regenerateOutfit}
          tryonJobs={tryonHook.jobs}
          onTryOn={tryonHook.startTryon}
        />
      )}
      {showCreator && (
        <OutfitCreator
          items={items}
          onCancel={handleCloseCreator}
          onCreate={createOutfit}
        />
      )}

      {isOutfitsView ? (
        <button
          className="outfit-fab"
          type="button"
          onClick={() => setShowCreator(true)}
          disabled={items.length < 2}
          aria-label="Create new outfit"
        >
          <Plus size={19} aria-hidden="true" />
        </button>
      ) : (
        <WardrobeImportFlow />
      )}
    </div>
  );
}
