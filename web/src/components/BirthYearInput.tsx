import { useEffect, useState } from "react";
import { BIRTH_YEAR_MAX, BIRTH_YEAR_MIN, youthYears } from "../../../shared/types";
import { validBirthYear } from "../roster";

/**
 * Optional birth-year field. Keeps the typed text locally so a half-typed year ("19") is not
 * rejected mid-keystroke; only a whole year in range is committed, and clearing it commits undefined.
 */
export function BirthYearInput({
  id,
  label,
  value,
  onChange,
  fallback,
}: {
  id: string;
  label: string;
  value: number | undefined;
  onChange: (year: number | undefined) => void;
  /** Shown when empty, e.g. the home default. */
  fallback?: number;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);
  const trimmed = draft.trim();
  const year = trimmed ? Number(trimmed) : undefined;
  const invalid = trimmed !== "" && !validBirthYear(year);
  const shown = invalid ? undefined : (year ?? fallback);
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        maxLength={4}
        value={draft}
        placeholder={fallback ? String(fallback) : `e.g. 1940`}
        aria-invalid={invalid || undefined}
        aria-describedby={hintId}
        onChange={(e) => {
          const t = e.target.value.replace(/\D/g, "").slice(0, 4);
          setDraft(t);
          if (t === "") onChange(undefined);
          else if (validBirthYear(Number(t))) onChange(Number(t));
        }}
      />
      <span id={hintId} className={invalid ? "hint hint-bad" : "hint"}>
        {invalid
          ? `Enter a year from ${BIRTH_YEAR_MIN} to ${BIRTH_YEAR_MAX}.`
          : shown
            ? `Film and TV lean toward ${youthYears(shown).from}–${youthYears(shown).to}, their teens and twenties.`
            : "Optional. Film and TV lean toward their teens and twenties."}
      </span>
    </div>
  );
}
