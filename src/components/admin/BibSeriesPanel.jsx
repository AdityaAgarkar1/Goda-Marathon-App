import React, { useState } from 'react';
import { AlertTriangle, Hash, Search } from 'lucide-react';
import { categoryForBib, formatBibSeries, bibNumber } from '../../utils/bibSeries';

/**
 * Which numbers belong to which race, and how far each series has got.
 *
 * Each category owns a bib series (migration 0017), so the number on a
 * runner's chest says which race they are in. This is the key to that code:
 * the table a kit-collection desk or the timing team works from, plus a
 * lookup for "which race is bib 15042?".
 *
 * `overview` comes from admin_bib_overview(); without it (an older database)
 * the series are still listed from the categories themselves.
 */
export default function BibSeriesPanel({ categories, overview }) {
  const [lookup, setLookup] = useState('');

  const statsById = new Map(overview.map(o => [o.category_id, o]));
  const rows = categories
    .filter(c => c.bib_start && c.bib_end)
    .sort((a, b) => a.bib_start - b.bib_start)
    .map(c => ({ ...c, stats: statsById.get(c.id) }));

  if (rows.length === 0) return null;

  const missing = rows.filter(r => r.stats?.missing > 0);
  const found = lookup.trim() ? categoryForBib(lookup, rows) : null;
  const lookupValid = bibNumber(lookup) !== null;

  return (
    <section className="admin-bib-panel glass" aria-labelledby="bib-series-title">
      <div className="admin-bib-panel-head">
        <div>
          <h4 id="bib-series-title"><Hash size={16} aria-hidden="true" /> Bib series</h4>
          <p className="admin-field-hint" style={{ marginTop: 2 }}>
            Every race has its own numbers, so a bib shows which race its runner is in.
            Bibs are issued automatically when an entry is confirmed; online entries get
            theirs when payment goes through.
          </p>
        </div>
        <label className="admin-bib-lookup">
          <Search size={14} aria-hidden="true" />
          <span className="sr-only">Look up a bib number</span>
          <input
            value={lookup}
            onChange={e => setLookup(e.target.value)}
            inputMode="numeric"
            placeholder="Which race is bib…?"
            aria-describedby="bib-lookup-result"
          />
        </label>
      </div>

      {lookup.trim() && (
        <p id="bib-lookup-result" className="admin-bib-lookup-result" role="status">
          {!lookupValid
            ? 'A bib is a whole number.'
            : found
              ? <>Bib <strong>{bibNumber(lookup)}</strong> is <strong>{found.name}</strong> ({formatBibSeries(found)}).</>
              : <>Bib <strong>{bibNumber(lookup)}</strong> is outside every series. It may be from an older edition.</>}
        </p>
      )}

      {missing.length > 0 && (
        <div className="admin-bib-warning" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            {missing.map(r => `${r.name}: ${r.stats.missing} confirmed ${r.stats.missing === 1 ? 'entry has' : 'entries have'} no bib`).join('; ')}.
            The series is full. Edit the category and raise the last bib number. The missing bibs are issued as soon as you save.
          </span>
        </div>
      )}

      <div className="admin-table-wrap">
        <table className="admin-table admin-bib-table">
          <thead>
            <tr>
              <th scope="col">Bibs</th>
              <th scope="col">Race</th>
              <th scope="col" className="admin-num">Issued</th>
              <th scope="col" className="admin-num">Awaiting payment</th>
              <th scope="col" className="admin-num">Numbers left</th>
              <th scope="col" className="admin-num">Next bib</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td><span className="admin-badge admin-badge-paid">{formatBibSeries(r)}</span></td>
                <td className="admin-cell-name">{r.name}</td>
                <td className="admin-num">
                  {r.stats ? r.stats.issued : '—'}
                  {r.stats?.retired > 0 && (
                    <span className="admin-cell-muted" title="Numbers held by cancelled entries. They are never reissued.">
                      {' '}(+{r.stats.retired} retired)
                    </span>
                  )}
                </td>
                <td className="admin-num">{r.stats ? r.stats.awaiting_payment : '—'}</td>
                <td className="admin-num">{r.stats ? r.stats.numbers_left : '—'}</td>
                <td className="admin-num">{r.stats ? (r.stats.next_bib || 'Full') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
