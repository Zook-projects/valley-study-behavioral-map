// Type-ahead + chip list for the 11 anchor ZIPs, plus a free-text search that
// lets you select any ZIP in the dataset (workplace OR residence side).

import { useMemo, useState } from 'react';
import type { ZipMeta } from '../types/flow';
import { ANCHOR_ZIPS } from '../lib/flowQueries';

interface Props {
  zips: ZipMeta[];
  selectedZip: string | null;
  onSelectZip: (zip: string | null) => void;
}

export function ZipSelector({ zips, selectedZip, onSelectZip }: Props) {
  const [query, setQuery] = useState('');
  const anchorZips = useMemo(
    () => ANCHOR_ZIPS.map((z) => zips.find((x) => x.zip === z)).filter(Boolean) as ZipMeta[],
    [zips],
  );

  const queryLower = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!queryLower) return [];
    return zips
      .filter((z) => !z.isSynthetic)
      .filter(
        (z) =>
          z.zip.includes(queryLower) || z.place.toLowerCase().includes(queryLower),
      )
      .slice(0, 6);
  }, [zips, queryLower]);

  return (
    <div className="space-y-2">
      <label
        className="block text-[10px] font-medium uppercase tracking-wider"
        style={{ color: 'var(--text-dim)' }}
      >
        Anchor Workplaces - Zip Codes
      </label>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Anchor workplace ZIPs">
        {anchorZips.map((z) => {
          const active = selectedZip === z.zip;
          return (
            <button
              key={z.zip}
              type="button"
              aria-pressed={active}
              aria-label={`${z.place}, ZIP ${z.zip}${active ? ' (selected)' : ''}`}
              onClick={() => onSelectZip(active ? null : z.zip)}
              className="text-[11px] px-2 py-1 rounded-md border transition-colors focus:outline-none focus-visible:ring-1"
              style={{
                background: active ? 'var(--accent)' : 'rgba(255,255,255,0.04)',
                color: active ? '#1a1207' : 'var(--text-h)',
                borderColor: active ? 'var(--accent)' : 'var(--panel-border)',
              }}
              title={`${z.place} (${z.zip})`}
            >
              {z.place}
            </button>
          );
        })}
      </div>
      <div className="relative pt-1">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search ZIP or place…"
          aria-label="Search any ZIP code or place name"
          aria-autocomplete="list"
          aria-expanded={matches.length > 0}
          className="w-full text-xs px-2.5 py-1.5 rounded-md outline-none"
          style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid var(--panel-border)',
            color: 'var(--text-h)',
          }}
        />
        {matches.length > 0 && (
          <ul
            role="listbox"
            aria-label="Matching ZIPs"
            className="absolute left-0 right-0 mt-1 rounded-md overflow-hidden z-20 shadow-lg"
            style={{
              background: 'rgba(20,22,28,0.95)',
              border: '1px solid var(--panel-border)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
            }}
          >
            {matches.map((z) => (
              <li key={z.zip} role="option" aria-selected={selectedZip === z.zip}>
                <button
                  type="button"
                  aria-label={`Select ${z.place}, ZIP ${z.zip}`}
                  className="w-full text-left text-xs px-2.5 py-1.5 hover:bg-white/5 flex justify-between"
                  onClick={() => {
                    onSelectZip(z.zip);
                    setQuery('');
                  }}
                >
                  <span style={{ color: 'var(--text-h)' }}>{z.place}</span>
                  <span style={{ color: 'var(--text-dim)' }}>{z.zip}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
