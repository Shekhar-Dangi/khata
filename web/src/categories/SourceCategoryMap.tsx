import { useState } from "react";

import CategorySelect from "../shared/CategorySelect";
import { errorText, mutate } from "../shared/api";
import { useFetch } from "../shared/useFetch";
import { useLedgerVersion } from "../shared/ledgerVersion";
import { rupees } from "../shared/format";
import type { CategoryNode } from "./CategoriesView";

// Which of an outside source's words land in which of our categories.
//
// THE SENTENCE THIS FINISHES. sources/CategoryChoice.tsx offers a category per RECORD, and
// says of the case it refuses: "Where the map has an answer, the place to change the answer
// is the map." There was no such place. This is it — and the two are different questions:
//
//   here            "Splitwise's Car is my Transport"      one answer, every Car row, forever
//   CategoryChoice  "this particular General was a fan"    one record, because General is a
//                                                          catch-all no single mapping fits
//
// WHY IT LIVES ON THIS PAGE rather than on Sources, where the import that surfaces an
// undecided word actually happens: the tree above says what our categories ARE, and this says
// which outside words land in them. They are one subject from two sides, and the question
// "should Splitwise's Car be Transport or Fuel?" is answerable only while looking at the tree
// that offers both.
//
// A DECISION, NOT A SETTING. Changing a mapping rewrites what the old one produced — the
// consumption it wrote and the allocations on records it had already explained. A mapping that
// only affected the next import would leave every row already carrying that word unclassified,
// which is most of the value of learning it.
//
// It never touches an answer a person wrote themselves. That is enforced on the server (see
// src/source-categories.ts) rather than trusted here, but it is said on screen too, because
// "will this undo what I did last week" is the question a person has before pressing one.

type SourceCategory = {
  sourceCategory: string;
  categoryId: number | null;
  categoryName: string | null;
  parentName: string | null;
  /** A row exists. false is "never seen" — the state that deserves a prompt. */
  decided: boolean;
  note: string | null;
  records: number;
  consumedRecords: number;
  consumedPaise: number;
};

export default function SourceCategoryMap({ categories }: { categories: CategoryNode[] }) {
  const { bump } = useLedgerVersion();
  const map = useFetch<{ categories: SourceCategory[] }>("/evidence/categories");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = map.data?.categories ?? [];
  // Nothing imported yet means nothing to translate. An empty table with a heading would be
  // a promise the page cannot keep for someone who has never opened Sources.
  if (rows.length === 0) return null;

  const undecided = rows.filter((r) => !r.decided).length;

  async function set(sourceCategory: string, categoryId: number | null) {
    setBusy(sourceCategory);
    setError(null);
    try {
      await mutate("/evidence/categories", {
        method: "POST",
        body: JSON.stringify({ source_category: sourceCategory, category_id: categoryId }),
      });
      await map.refetch();
      // Consumption, the category totals on this very page, and the unexplained figure all
      // move when a mapping changes — and they live in other subtrees. See ledgerVersion.tsx.
      bump();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="source-map">
      <h3 className="report-h">Where Splitwise&rsquo;s words land</h3>
      <p className="soft rules-intro">
        One answer here applies to every record carrying that word, including ones already
        imported. It never changes a category you chose on a single record yourself.
        {undecided > 0 && (
          <>
            {" "}
            <span className="flag">{undecided} still undecided.</span>
          </>
        )}
      </p>

      {error !== null && <p className="note">{error}</p>}

      <div className="table-scroll">
        <table>
          <colgroup>
            <col style={{ width: "200px" }} />
            <col style={{ width: "250px" }} />
            <col style={{ width: "140px" }} />
            <col style={{ width: "110px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Splitwise says</th>
              <th>Lands in</th>
              <th className="r">Consumed</th>
              <th className="r">Records</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sourceCategory} className={r.decided ? undefined : "undecided"}>
                <td className="cat-label">
                  {r.sourceCategory}
                  {!r.decided && <span className="pill flag">new</span>}
                </td>
                <td>
                  {/* ONE control, not a picker plus a "can't be mapped" button beside it.
                      CategorySelect's placeholder already emits null, so the button was a
                      second way to write the same field — and repeated down fifteen rows it
                      read as the loudest thing on the page while saying nothing new.

                      The placeholder's WORDING is what carries the distinction the map cares
                      about: "Choose…" for a word nobody has ruled on, "Can't be mapped" for
                      one where that was the answer. Same null, different meaning, and the
                      amber row says which is which at a glance. */}
                  <CategorySelect
                    value={r.categoryId}
                    categories={categories}
                    disabled={busy !== null}
                    placeholder={r.decided ? "Can't be mapped" : "Choose…"}
                    onChange={(id) => void set(r.sourceCategory, id)}
                  />
                </td>
                <td className="mono r">
                  {r.consumedPaise === 0 ? <span className="soft">—</span> : rupees(r.consumedPaise)}
                </td>
                <td className="mono r soft">{r.records}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
