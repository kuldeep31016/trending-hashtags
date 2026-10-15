import { colorMap } from "../lib/format";

const MAX = 6; // more lines than this stops being readable; colors stay within the validated set

/** Toggle chips; selection order fixes each hashtag's color, so ranks changing never repaint lines. */
export function TagPicker({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const all = [...value.filter((t) => !options.includes(t)), ...options];
  const colors = colorMap(value);
  const toggle = (t: string) => {
    if (value.includes(t)) onChange(value.filter((x) => x !== t));
    else if (value.length < MAX) onChange([...value, t]);
  };
  if (!all.length) return null;
  return (
    <div role="group" aria-label={`Hashtags to plot (up to ${MAX})`} className="flex flex-wrap gap-1.5">
      {all.map((t) => {
        const on = value.includes(t);
        const full = !on && value.length >= MAX;
        return (
          <button
            key={t}
            aria-pressed={on}
            disabled={full}
            title={full ? `Up to ${MAX} hashtags` : undefined}
            onClick={() => toggle(t)}
            className={`inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-ctl)] border px-2 text-[12px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
              on ? "border-line-strong bg-raised text-ink" : "border-line text-ink-3 hover:text-ink"
            }`}
          >
            <span aria-hidden className="size-2 rounded-full" style={{ background: on ? colors[t] : "var(--line-strong)" }} />#{t}
          </button>
        );
      })}
    </div>
  );
}
