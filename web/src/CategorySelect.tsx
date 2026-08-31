import type { Category } from "./transactions";

// The category picker, in ONE place.
//
// It was written inline in AllocationEditor and is now needed by the candidate rows too.
// A second hand-rolled copy is how the two drift: the parent/child optgroup structure
// carries a real rule of the taxonomy — a parent is selectable as "(general)", so money
// can land on "Shopping" without claiming to know which kind — and a copy that forgot
// that would silently offer a different taxonomy on a different screen.
//
// Same reasoning as rules.ts owning the rule vocabulary rather than routes/rules.ts
// declaring its own.
export default function CategorySelect({
  value,
  onChange,
  categories,
  placeholder = "Category…",
  disabled = false,
}: {
  value: number | null;
  onChange: (categoryId: number | null) => void;
  categories: Category[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const parents = categories.filter((c) => c.parent_id == null);

  return (
    <select
      className="cat-select"
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">{placeholder}</option>
      {parents.map((p) => (
        <optgroup key={p.id} label={p.name}>
          <option value={p.id}>{p.name} (general)</option>
          {categories
            .filter((c) => c.parent_id === p.id)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}
