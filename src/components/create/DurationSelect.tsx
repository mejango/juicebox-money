import { FOREVER_SECONDS } from "@/lib/launch";
import {
  DURATION_PRESETS,
  DURATION_UNIT_SECONDS,
  durationFieldsSeconds,
  type DurationFields,
} from "./stage-draft";

/** The cycle length control: presets, forever, or a custom length in a unit. */
export function DurationSelect({
  fields,
  onChange,
  disabled,
  zeroLabel = "Flexible",
  forever = true,
}: {
  fields: DurationFields;
  onChange: (patch: Partial<DurationFields>) => void;
  disabled?: boolean;
  /** What a length of 0 is called here. */
  zeroLabel?: string;
  /** Whether "Forever" is offered. */
  forever?: boolean;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2.5">
      <select
        aria-label="Duration"
        value={fields.durationValue}
        onChange={(e) => onChange({ durationValue: e.target.value })}
        disabled={disabled}
        className="input-well select-caret min-h-[44px] w-44 px-3.5 pr-9 text-sm disabled:opacity-60"
      >
        <option value="0">{zeroLabel}</option>
        {DURATION_PRESETS.map(([seconds, label]) => (
          <option key={seconds} value={String(seconds)}>
            {label}
          </option>
        ))}
        {forever ? <option value={String(FOREVER_SECONDS)}>Forever</option> : null}
        <option value="custom">Custom…</option>
      </select>
      {fields.durationValue === "custom" ? (
        <>
          <input
            type="text"
            inputMode="decimal"
            aria-label="Custom duration"
            value={fields.customDuration}
            onChange={(e) => onChange({ customDuration: e.target.value.slice(0, 6) })}
            disabled={disabled}
            placeholder="30"
            className={`input-well min-h-[44px] w-20 px-3 text-sm tabular-nums disabled:opacity-60 ${
              durationFieldsSeconds(fields) === null ? "!border-red-400" : ""
            }`}
          />
          <select
            aria-label="Duration unit"
            value={fields.customUnit}
            onChange={(e) =>
              onChange({ customUnit: e.target.value as DurationFields["customUnit"] })
            }
            disabled={disabled}
            className="input-well select-caret min-h-[44px] w-28 px-3 pr-9 text-sm disabled:opacity-60"
          >
            {(Object.keys(DURATION_UNIT_SECONDS) as DurationFields["customUnit"][]).map(
              (unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ),
            )}
          </select>
        </>
      ) : null}
    </div>
  );
}
