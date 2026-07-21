import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, Plus, SpinnerGap, Trash, UploadSimple, UserFocus, WarningCircle, X } from "@phosphor-icons/react";
import { useConvexImportFlow } from "./hooks/useConvex.js";
import "./import-flow.css";

const PARTS = [
  ["upperbody", "Tops"],
  ["wholebody_up", "Jackets"],
  ["lowerbody", "Bottoms"],
  ["accessories_up", "Accessories"],
  ["shoes", "Shoes"],
];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function deriveStatus(job) {
  if (job.kind === "upload") {
    if (job.analysis?.status === "failed") return { tone: "error", text: "Analysis needs attention", detail: job.analysis.error || "The computer could not analyze this photo." };
    if (job.analysis?.status === "empty") return { tone: "complete", text: "No clothing detected" };
    if (job.analysis?.status === "processing") return { tone: "processing", text: "Finding clothes in photo" };
    return { tone: "processing", text: "Cloud analysis queued" };
  }
  const crop = job.stages?.crop;
  const garment = job.stages?.garment;
  const modeled = job.stages?.modeled;
  if (job.error || crop?.status === "failed" || garment?.status === "failed" || modeled?.status === "failed") return { tone: "error", text: "Import needs attention", detail: crop?.error || garment?.error || modeled?.error || job.error };
  if (modeled?.status === "review") return { tone: "ready", text: "Modeled image ready for review" };
  if (modeled?.status === "processing") return { tone: "processing", text: "Styling modeled image" };
  if (garment?.status === "review") return { tone: "ready", text: "Ready for review" };
  if (garment?.status === "approved") return { tone: "processing", text: "Creating modeled image" };
  if (crop?.status === "review") return { tone: "ready", text: "Crop ready for review" };
  if (crop?.status === "approved" && garment?.status === "pending") return { tone: "processing", text: "Starting garment generation" };
  if (crop?.status === "approved" && garment?.status === "processing") return { tone: "processing", text: "Creating garment image" };
  if (crop?.status === "rejected" || garment?.status === "rejected" || modeled?.status === "rejected") return { tone: "complete", text: "Import declined" };
  if (job.productMatch?.status === "processing") return { tone: "processing", text: "Matching exact product" };
  return { tone: "processing", text: "Extracting clothing from image" };
}

function reviewStageFor(job) {
  if (job.stages?.modeled?.status === "review") return "modeled";
  if (job.stages?.garment?.status === "review") return "garment";
  if (job.stages?.crop?.status === "review") return "crop";
  return null;
}

function defaultDraft(job) {
  const metadata = job.metadata || {};
  return {
    name: metadata.name || "New piece",
    part: metadata.part || "upperbody",
    color: metadata.color || "#d8d0c2",
    secondaryColor: metadata.secondaryColor || "",
    tags: Array.isArray(metadata.tags) ? metadata.tags.join(", ") : (metadata.tags || ""),
  };
}

function ReviewEditor({ job, stage, draft, setDraft, regenPrompt, setRegenPrompt, busy, onAction }) {
  const asset = job.stages[stage]?.assetUrl || job.originalAssetUrl;
  const isCrop = stage === "crop";
  const isGarment = stage === "garment";
  const primaryValid = HEX_COLOR.test(draft.color);
  const secondaryValid = !draft.secondaryColor || HEX_COLOR.test(draft.secondaryColor);
  return (
    <div className="import-editor">
      <img className="import-editor__preview" src={asset} alt={isCrop ? "Detected item crop" : isGarment ? "Extracted garment" : "Generated modeled look"} />
      <div className="import-fields">
        <p className="import-editor__stage">{isCrop ? "Detected item" : isGarment ? "Garment image" : "Modeled image"}</p>
        {isCrop ? <p className="import-card__detail">Check that this crop contains the complete intended item. Approving it starts the clean garment-image generation.</p> : isGarment ? (
          <>
            {job.metadata?.productName && <div className="import-product-match"><span>{job.metadata.productConfidence === "exact" ? "Exact product" : "Possible product"}</span><strong>{[job.metadata.brand, job.metadata.productName].filter(Boolean).join(" ")}</strong>{job.metadata.productUrl && <a href={job.metadata.productUrl} target="_blank" rel="noreferrer">Open source</a>}</div>}
            <div className="import-field"><label htmlFor={`name-${job.id}`}>Name</label><input id={`name-${job.id}`} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
            <div className="import-field"><label htmlFor={`part-${job.id}`}>Category</label><select id={`part-${job.id}`} value={draft.part} onChange={(event) => setDraft({ ...draft, part: event.target.value })}>{PARTS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></div>
            <div className="import-field"><label htmlFor={`primary-${job.id}`}>Primary color</label><div className="import-color-row"><input id={`primary-${job.id}`} type="color" value={primaryValid ? draft.color : "#000000"} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /><input aria-label="Primary color hex" aria-invalid={!primaryValid} value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></div>{!primaryValid && <small className="import-field-error">Use a six-digit hex color, such as #d8d0c2.</small>}</div>
            <div className="import-field"><label htmlFor={`secondary-${job.id}`}>Secondary color <span>optional</span></label><input id={`secondary-${job.id}`} type="text" aria-invalid={!secondaryValid} placeholder="#hex or leave blank" value={draft.secondaryColor} onChange={(event) => setDraft({ ...draft, secondaryColor: event.target.value })} />{!secondaryValid && <small className="import-field-error">Use a six-digit hex color or leave this empty.</small>}</div>
            <div className="import-field"><label htmlFor={`tags-${job.id}`}>Details</label><input id={`tags-${job.id}`} value={draft.tags} placeholder="casual, cotton, striped" onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></div>
          </>
        ) : <p className="import-card__detail">Approve this editorial image to attach it to the new wardrobe piece, or regenerate it with a more specific direction.</p>}
        {!isCrop && <div className="import-field import-regenerate-field">
          <label htmlFor={`regenerate-${job.id}-${stage}`}>Regeneration direction <span>optional</span></label>
          <textarea id={`regenerate-${job.id}-${stage}`} rows="3" value={regenPrompt} onChange={(event) => setRegenPrompt(event.target.value)} placeholder={isGarment ? "Example: preserve the original zipper and remove the retail tag" : "Example: use a quiet evening street and show the full garment"} />
        </div>}
        <div className="import-actions">
          <button className="import-button" disabled={busy} onClick={() => onAction("reject")}><Trash size={14} /> Reject</button>
          {!isCrop && <button className="import-button" disabled={busy} onClick={() => onAction("regenerate", regenPrompt)}><ArrowCounterClockwise size={14} /> Regenerate</button>}
          <button className="import-button import-button--primary" disabled={busy || (isGarment && (!draft.name.trim() || !primaryValid || !secondaryValid))} onClick={() => onAction("approve")}><Check size={14} weight="bold" /> {isCrop ? "Use crop" : "Approve"}</button>
        </div>
      </div>
    </div>
  );
}

export function WardrobeImportFlow() {
  const inputRef = useRef(null);
  const referenceInputRef = useRef(null);
  const [drafts, setDrafts] = useState({});
  const [regenerationPrompts, setRegenerationPrompts] = useState({});
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedReviewId, setSelectedReviewId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [uploading, setUploading] = useState(null);
  const [modelRefPanelOpen, setModelRefPanelOpen] = useState(false);

  // ── Convex hooks (replaces all fetch() calls + polling) ──
  const {
    jobs, setup, modelReferences, loading,
    uploadAndImport, saveModelReference,
    approveStage, rejectStage, regenerateStage,
    updateJobMetadata, deleteJob, retryAnalysis,
    deleteModelReference,
  } = useConvexImportFlow();

  // ── Draft management ──
  // When jobs change, update drafts for new item jobs
  useEffect(() => {
    setDrafts((current) => {
      const next = { ...current };
      for (const job of jobs) {
        if (job.kind !== "upload" && !next[job.id]) {
          next[job.id] = defaultDraft(job);
        }
      }
      // Clean up drafts for jobs no longer in the list
      const jobIds = new Set(jobs.map((j) => j.id));
      for (const id of Object.keys(next)) {
        if (!jobIds.has(id)) delete next[id];
      }
      return next;
    });
  }, [jobs]);

  const submitFiles = useCallback(async (files) => {
    if (!setup?.ready) { setOpen(true); return; }
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    setDragging(false); setError(""); setNotice(null);
    setUploading({ sent: 0, total: images.length });

    try {
      const result = await uploadAndImport(images, true);
      setUploading({ sent: result.successes, total: images.length });
      if (result.failures.length) {
        setError(`${result.failures.length} ${result.failures.length === 1 ? "photo" : "photos"} could not be uploaded. Choose ${result.failures.length === 1 ? "it" : "them"} again when the connection is stable.`);
      }
    } catch (requestError) {
      setError(`Wardrobe could not upload: ${requestError.message}`);
    } finally {
      setUploading(null);
    }
  }, [setup, uploadAndImport]);

  const submitReference = useCallback(async (files) => {
    const remaining = Math.max(0, (setup?.maxModelReferences || 5) - (setup?.modelReferenceCount || 0));
    if (!remaining) return;
    const images = [...files].filter((file) => file.type.startsWith("image/")).slice(0, remaining);
    if (!images.length) return;
    setError("");
    try {
      await saveModelReference(images);
      setNotice({ tone: "complete", text: `${(setup?.modelReferenceCount || 0) + images.length} reference ${(setup?.modelReferenceCount || 0) + images.length === 1 ? "photo" : "photos"} saved`, detail: "These photos of yourself help the AI generate consistent outfit images." });
    } catch (requestError) { setError(requestError.message); }
  }, [setup, saveModelReference]);

  useEffect(() => {
    let depth = 0;
    const onDragEnter = (event) => { if (![...event.dataTransfer.types].includes("Files")) return; event.preventDefault(); depth += 1; setDragging(true); };
    const onDragOver = (event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); };
    const onDragLeave = (event) => { event.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const onDrop = (event) => { event.preventDefault(); depth = 0; setDragging(false); submitFiles(event.dataTransfer.files); };
    const onPaste = (event) => { const files = [...event.clipboardData.files]; if (files.some((file) => file.type.startsWith("image/"))) { event.preventDefault(); submitFiles(files); } };
    window.addEventListener("dragenter", onDragEnter); window.addEventListener("dragover", onDragOver); window.addEventListener("dragleave", onDragLeave); window.addEventListener("drop", onDrop); window.addEventListener("paste", onPaste);
    return () => { window.removeEventListener("dragenter", onDragEnter); window.removeEventListener("dragover", onDragOver); window.removeEventListener("dragleave", onDragLeave); window.removeEventListener("drop", onDrop); window.removeEventListener("paste", onPaste); };
  }, [submitFiles]);

  const perform = async (job, stage, action, prompt = "") => {
    setBusyId(job.id); setError("");
    try {
      if (action === "approve") {
        // If garment stage, save metadata first
        if (stage === "garment") {
          const draft = drafts[job.id];
          const metadata = {
            ...draft,
            secondaryColor: draft.secondaryColor || null,
            tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
          };
          await updateJobMetadata(job.id, metadata);
        }
        await approveStage(job.id, stage);
        // Remove from local tracking if modeled approved or any rejected
        if (stage === "modeled") {
          setDrafts((current) => { const next = { ...current }; delete next[job.id]; return next; });
          setSelectedReviewId(null);
        }
      } else if (action === "reject") {
        await rejectStage(job.id, stage);
        setDrafts((current) => { const next = { ...current }; delete next[job.id]; return next; });
        setSelectedReviewId(null);
      } else if (action === "regenerate") {
        await regenerateStage(job.id, stage, prompt);
        if (action === "regenerate") setRegenerationPrompts((current) => ({ ...current, [`${job.id}:${stage}`]: "" }));
      }
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const handleDeleteJob = async (job) => {
    setBusyId(job.id); setError("");
    try {
      await deleteJob(job.id);
      setDrafts((current) => { const next = { ...current }; delete next[job.id]; return next; });
      if (selectedReviewId === job.id) setSelectedReviewId(null);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const handleRetryAnalysis = async (job) => {
    setBusyId(job.id); setError("");
    try {
      await retryAnalysis(job.id);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const handleDeleteModelRef = async (refId) => {
    setBusyId(refId); setError("");
    try {
      await deleteModelReference(refId);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const active = jobs[jobs.length - 1];
  const missingApiKey = setup?.hasApiKey === false;
  const missingModelReference = setup?.hasModelReference === false;
  const setupRequired = setup?.ready === false;
  const setupLabel = missingApiKey ? "Cloud setup needed" : missingModelReference ? "Add your photo" : "Setup required";
  const uploadStatus = uploading ? { tone: "processing", text: `Saving ${Math.min(uploading.sent + 1, uploading.total)} of ${uploading.total}` } : null;
  const activeStatus = setupRequired ? { tone: missingApiKey ? "error" : "setup", text: setupLabel } : uploadStatus || (active ? deriveStatus(active) : notice);
  const readyCount = jobs.filter((job) => deriveStatus(job).tone === "ready").length;
  const selectedReviewJob = jobs.find((job) => job.id === selectedReviewId && reviewStageFor(job));
  const reviewJob = selectedReviewJob || jobs.find((job) => reviewStageFor(job)) || active;
  const reviewStage = reviewJob ? reviewStageFor(reviewJob) : null;
  const progress = 0;
  const hasImportActivity = Boolean(jobs.length || notice || setupRequired || uploading);
  const referenceCount = setup?.modelReferenceCount || 0;
  const referencesFull = referenceCount >= (setup?.maxModelReferences || 5);

  return (
    <>
      <input ref={inputRef} type="file" accept="image/*" multiple hidden disabled={!setup?.ready} onChange={(event) => { submitFiles(event.target.files); event.target.value = ""; }} />
      <input ref={referenceInputRef} type="file" accept="image/*" multiple hidden disabled={setup?.modelReferenceCount >= (setup?.maxModelReferences || 5)} onChange={(event) => { submitReference(event.target.files); event.target.value = ""; }} />
      <div className="import-drop-overlay" data-active={dragging && !setupRequired} aria-hidden={!dragging || setupRequired}><div className="import-drop-target is-over"><UploadSimple size={34} weight="light" /><h2>Drop clothing images</h2><p>A single garment or a photo of a full outfit works. Your wardrobe stays exactly where you left it.</p></div></div>
      <aside className={`import-tray ${hasImportActivity ? "is-expanded" : "is-idle"}`} aria-label="Wardrobe imports">
        <button className="import-tray__button" type="button" onClick={() => setupRequired ? setOpen(true) : missingModelReference ? referenceInputRef.current?.click() : hasImportActivity ? setOpen(true) : inputRef.current?.click()} aria-label={missingModelReference && !missingApiKey ? "Add your photo" : setupRequired ? "Open setup instructions" : hasImportActivity ? "Open import progress" : "Add clothes"}>{activeStatus?.tone === "processing" ? <SpinnerGap size={19} className="import-spinner" /> : activeStatus?.tone === "error" ? <WarningCircle size={19} /> : activeStatus?.tone === "setup" ? <UploadSimple size={19} /> : readyCount ? <span>{readyCount}</span> : notice ? <X size={18} /> : <Plus size={19} />}</button>
        <div className="import-tray__actions">{active && <img className="import-tray__preview" src={active.stages?.garment?.assetUrl || active.stages?.crop?.assetUrl || active.originalAssetUrl} alt="" />}<span className="import-tray__label">{activeStatus?.text || "Add clothes"}</span>{!setupRequired && <><button className="import-icon-button" type="button" onClick={() => inputRef.current?.click()} aria-label="Choose clothing images"><UploadSimple size={17} /></button><button className="import-icon-button" type="button" disabled={referencesFull} onClick={() => referenceCount > 0 ? setModelRefPanelOpen(true) : referenceInputRef.current?.click()} aria-label={referencesFull ? `${referenceCount} reference photos saved` : `Add your reference photos; ${referenceCount} saved`}><UserFocus size={17} /></button></>}</div>
      </aside>
      {modelRefPanelOpen && (
        <div className="import-popover-backdrop" data-open={true} onMouseDown={(event) => event.target === event.currentTarget && setModelRefPanelOpen(false)}>
          <section className="import-popover" role="dialog" aria-modal="true" aria-labelledby="model-ref-title">
            <header className="import-popover__header"><div><p className="import-popover__eyebrow">Your photos</p><h2 className="import-popover__title" id="model-ref-title">{referenceCount} {referenceCount === 1 ? "photo" : "photos"} saved</h2></div><button className="import-icon-button" type="button" onClick={() => setModelRefPanelOpen(false)} aria-label="Close reference photos"><X size={20} /></button></header>
            <p className="import-setup-note">Photos of yourself used as reference so the AI can keep your look consistent when generating outfit images.</p>
            <div className="import-card-list">
              {modelReferences.map((ref) => (
                <article className="import-card is-complete" key={ref.id}>
                  <img className="import-card__image" src={ref.url} alt="Your reference photo" />
                  <div className="import-card__body">
                    <h3 className="import-card__title">Reference photo</h3>
                  </div>
                  <div className="import-card__actions">
                    <button className="import-icon-button import-card__delete" disabled={busyId === ref.id} onClick={() => handleDeleteModelRef(ref.id)} aria-label="Delete reference photo"><Trash size={16} /></button>
                  </div>
                </article>
              ))}
            </div>
            <div className="import-actions">
              <button className="import-button" disabled={referencesFull} onClick={() => referenceInputRef.current?.click()}><Plus size={14} /> Add {referencesFull ? "" : "another "}</button>
            </div>
            {error && <p className="import-status is-error" role="alert">{error}</p>}
          </section>
        </div>
      )}
      <div className="import-popover-backdrop" data-open={open} onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
        <section className="import-popover" role="dialog" aria-modal="true" aria-labelledby="import-title">
          <header className="import-popover__header"><div><p className="import-popover__eyebrow">Wardrobe import</p><h2 className="import-popover__title" id="import-title">{readyCount ? `${readyCount} ready for review` : missingApiKey ? "Connect OpenAI on your computer" : missingModelReference ? "Add your reference photos" : activeStatus?.tone === "error" ? "Import needs attention" : jobs.length ? "Preparing new pieces" : notice?.text || "Add to your wardrobe"}</h2></div><button className="import-icon-button" type="button" onClick={() => setOpen(false)} aria-label="Close import progress"><X size={20} /></button></header>
          {!jobs.length ? setupRequired ? <div className="import-drop-target import-setup-warning">{missingApiKey ? <><WarningCircle size={30} /><h2>Finish cloud setup</h2><p>Add your OpenAI API key to the Convex environment variables, then redeploy. Your phone never needs the key.</p></> : <><UserFocus size={30} /><h2>Choose photos of yourself</h2><p>Add up to five clear photos from different angles. Wardrobe stores them privately and uses them together for modeled styling.</p><button className="import-button import-button--primary" onClick={() => referenceInputRef.current?.click()}>Choose reference photos</button><p className="import-setup-note">A full-body photo plus a clear face and side angle works well. You can add more later.</p></>}</div> : <div className="import-drop-target"><UploadSimple size={28} /><h2>{notice ? "Ready for clothes" : "Choose or paste images"}</h2><p>{notice?.detail || "The cloud identifies each exact product when the evidence supports it, creates catalog and modeled images, and adds successful pieces automatically."}</p><button className="import-button import-button--primary" disabled={!setup?.ready} onClick={() => { setNotice(null); inputRef.current?.click(); }}>Choose images</button><button className="import-reference-link" disabled={referencesFull} onClick={() => referenceCount > 0 ? (setModelRefPanelOpen(true), setOpen(false)) : referenceInputRef.current?.click()}><UserFocus size={15} /> {referencesFull ? `${referenceCount} reference photos saved` : `Add reference photos · ${referenceCount} saved`}</button></div> : (
            <>
              <div className={`import-progress${activeStatus?.tone !== "processing" ? " is-reviewing" : progress < 100 ? " is-indeterminate" : ""}`}><div className="import-progress__meta"><span>{activeStatus?.text}</span><span>{jobs.length} {jobs.length === 1 ? "item" : "items"}</span></div>{activeStatus?.tone === "processing" && <div className="import-progress__track"><div className="import-progress__bar" style={{ "--import-progress": `${progress}%` }} /></div>}</div>
              {reviewJob && reviewStage ? <ReviewEditor job={reviewJob} stage={reviewStage} draft={drafts[reviewJob.id] || defaultDraft(reviewJob)} setDraft={(draft) => setDrafts((current) => ({ ...current, [reviewJob.id]: draft }))} regenPrompt={regenerationPrompts[`${reviewJob.id}:${reviewStage}`] || ""} setRegenPrompt={(prompt) => setRegenerationPrompts((current) => ({ ...current, [`${reviewJob.id}:${reviewStage}`]: prompt }))} busy={busyId === reviewJob.id} onAction={(action, prompt) => perform(reviewJob, reviewStage, action, prompt)} /> : null}
              <div className="import-card-list">{jobs.map((job) => { const status = deriveStatus(job); const itemName = drafts[job.id]?.name || job.metadata?.name || "New piece"; const failedStage = job.stages?.garment?.status === "failed" ? "garment" : job.stages?.modeled?.status === "failed" ? "modeled" : null; const analysisFailed = job.kind === "upload" && job.analysis?.status === "failed"; return <article className={`import-card is-${status.tone}${reviewJob?.id === job.id ? " is-selected" : ""}`} key={job.id}><img className="import-card__image" src={job.stages?.garment?.assetUrl || job.stages?.crop?.assetUrl || job.originalAssetUrl} alt="" /><div className="import-card__body"><h3 className="import-card__title">{itemName}</h3><p className="import-card__detail import-card__detail--status" data-tone={status.tone}>{status.tone === "error" ? status.detail : status.text}</p></div><div className="import-card__actions">{status.tone === "ready" && <button className="import-icon-button" onClick={() => { setSelectedReviewId(job.id); setOpen(true); }} aria-label={`Review ${itemName}`}><Check size={17} /></button>}{analysisFailed && <button className="import-button import-card__retry" disabled={busyId === job.id} onClick={() => handleRetryAnalysis(job)}><ArrowCounterClockwise size={14} /> Retry</button>}{failedStage && <button className="import-button import-card__retry" disabled={busyId === job.id} onClick={() => perform(job, failedStage, "regenerate", "")}><ArrowCounterClockwise size={14} /> Retry</button>}<button className="import-icon-button import-card__delete" disabled={busyId === job.id} onClick={() => handleDeleteJob(job)} aria-label={`Delete ${itemName} from import queue`}><Trash size={16} /></button></div></article>; })}</div>
              <div className="import-actions"><button className="import-button" disabled={referencesFull} onClick={() => { setModelRefPanelOpen(true); setOpen(false); }}><UserFocus size={14} /> {referencesFull ? `${referenceCount} reference photos saved` : `Reference photos · ${referenceCount}`}</button><button className="import-button" onClick={() => inputRef.current?.click()}><Plus size={14} /> Add another</button></div>
            </>
          )}
          {error && <p className="import-status is-error" role="alert">{error}</p>}
        </section>
      </div>
    </>
  );
}
