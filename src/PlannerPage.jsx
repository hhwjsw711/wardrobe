import { useCallback, useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { ArrowLeft, Check as CheckIcon, CoatHanger, Plus, X } from "@phosphor-icons/react";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Format a Date as YYYY-MM-DD. */
function fmt(d) { return d.toISOString().slice(0, 10); }

/** Get the Monday of the week containing `date`. */
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  // Shift to Monday (getDay: 0=Sun, 1=Mon, ..., 6=Sat)
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Generate 7 dates starting from weekStart. */
function getWeekDays(weekStart) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

function isToday(d) { return fmt(d) === fmt(new Date()); }

function isPast(d) {
  const today = new Date(); today.setHours(0,0,0,0);
  const dd = new Date(d); dd.setHours(0,0,0,0);
  return dd < today;
}

/**
 * Planner page: week calendar view with outfit scheduling + wear tracking.
 */
export function PlannerPage({ onClose, outfits }) {
  const [weekOffset, setWeekOffset] = useState(0); // 0 = current week
  const [pickerForDate, setPickerForDate] = useState(null); // date string or null

  // Compute week range
  const today = useMemo(() => new Date(), []);
  const weekStart = useMemo(() => {
    const ref = new Date(today);
    ref.setDate(ref.getDate() + weekOffset * 7);
    return getWeekStart(ref);
  }, [today, weekOffset]);
  const weekDays = useMemo(() => getWeekDays(weekStart), [weekStart]);

  const startDate = fmt(weekDays[0]);
  const endDate = fmt(weekDays[6]);

  // Fetch planner entries + outfit list for the week
  const entries = useQuery(api.planner.getPlanner, { startDate, endDate });
  const planOutfit = useMutation(api.planner.planOutfit);
  const removePlannerEntry = useMutation(api.planner.removePlannerEntry);
  const markWorn = useMutation(api.planner.markWorn);

  // Build a map: date string → entry
  const entryMap = useMemo(() => {
    if (!entries) return {};
    const map = {};
    for (const e of entries) map[e.date] = e;
    return map;
  }, [entries]);

  // Available outfits for the picker
  const availableOutfits = outfits || [];

  const handleSelectOutfit = useCallback(async (date, outfitId) => {
    await planOutfit({ date, outfitId });
    setPickerForDate(null);
  }, [planOutfit]);

  const handleRemove = useCallback(async (date) => {
    const entry = entryMap[date];
    if (entry) await removePlannerEntry({ id: entry._id });
  }, [entryMap, removePlannerEntry]);

  const handleToggleWorn = useCallback(async (date) => {
    const entry = entryMap[date];
    if (!entry) return;
    await markWorn({ id: entry._id, worn: !entry.worn });
  }, [entryMap, markWorn]);

  // Week navigation label
  const weekLabel = useMemo(() => {
    const start = weekDays[0];
    const end = weekDays[6];
    const monthStart = start.toLocaleDateString("en-US", { month: "short" });
    const monthEnd = end.toLocaleDateString("en-US", { month: "short" });
    const dayStart = start.getDate();
    const dayEnd = end.getDate();
    if (monthStart === monthEnd) return `${monthStart} ${dayStart} – ${dayEnd}`;
    return `${monthStart} ${dayStart} – ${monthEnd} ${dayEnd}`;
  }, [weekDays]);

  return (
    <div className="planner-page">
      <div className="planner-header">
        <button className="planner-back" onClick={onClose} aria-label="Back to wardrobe">
          <ArrowLeft size={20} />
        </button>
        <h1 className="planner-title">Planner</h1>
      </div>

      <div className="planner-content">
        {/* Week navigation */}
        <div className="planner-nav">
          <button className="planner-nav-btn" onClick={() => setWeekOffset(w => w - 1)} aria-label="Previous week">
            &larr;
          </button>
          <span className="planner-week-label">{weekLabel}</span>
          <button className="planner-nav-btn" onClick={() => setWeekOffset(w => w + 1)} aria-label="Next week">
            &rarr;
          </button>
          {weekOffset !== 0 && (
            <button className="planner-today-btn" onClick={() => setWeekOffset(0)}>
              Today
            </button>
          )}
        </div>

        {/* Week grid */}
        <div className="planner-grid">
          {weekDays.map((day) => {
            const dateStr = fmt(day);
            const entry = entryMap[dateStr];
            const today = isToday(day);
            const past = isPast(day);
            const showPicker = pickerForDate === dateStr;

            return (
              <div key={dateStr} className={`planner-day ${today ? "planner-day--today" : ""} ${past ? "planner-day--past" : ""}`}>
                <div className="planner-day-header">
                  <span className="planner-day-name">{DAY_NAMES[day.getDay()]}</span>
                  <span className="planner-day-num">{day.getDate()}</span>
                </div>

                <div className="planner-day-body">
                  {entry?.outfit ? (
                    <div className="planner-day-outfit">
                      {entry.outfit?.imageUrl && (
                        <img className="planner-day-img" src={entry.outfit.imageUrl} alt="" />
                      )}
                      <span className="planner-day-outfit-name">{entry.outfit?.name || "Outfit"}</span>
                      <div className="planner-day-actions">
                        <button
                          className={`planner-worn-btn ${entry.worn ? "planner-worn-btn--active" : ""}`}
                          onClick={() => handleToggleWorn(dateStr)}
                          title={entry.worn ? "Mark as not worn" : "Mark as worn"}
                        >
                          <CheckIcon size={12} weight="bold" /> {entry.worn ? "Worn" : "Wear"}
                        </button>
                        <button className="planner-remove-btn" onClick={() => handleRemove(dateStr)} title="Remove">
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="planner-add-btn"
                      onClick={() => setPickerForDate(showPicker ? null : dateStr)}
                    >
                      <Plus size={14} /> Plan
                    </button>
                  )}
                </div>

                {/* Outfit picker dropdown */}
                {showPicker && (
                  <div className="planner-picker">
                    <div className="planner-picker-header">
                      <span>Select outfit</span>
                      <button onClick={() => setPickerForDate(null)}><X size={14} /></button>
                    </div>
                    {availableOutfits.length === 0 ? (
                      <p className="planner-picker-empty">No outfits yet. Create one first!</p>
                    ) : (
                      <ul className="planner-picker-list">
                        {availableOutfits.map((outfit) => (
                          <li key={outfit.id}>
                            <button onClick={() => handleSelectOutfit(dateStr, outfit.id)}>
                              {outfit.image && (
                                <img
                                  src={outfit.image}
                                  alt=""
                                  className="planner-picker-thumb"
                                />
                              )}
                              <span>{outfit.name || "Outfit"}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Stats / summary */}
        {entries && entries.length > 0 && (
          <div className="planner-summary">
            <span>
              {entries.filter(e => e.worn).length} worn &middot; {entries.filter(e => e.outfitId && !e.worn).length} planned
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
