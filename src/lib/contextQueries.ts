// contextQueries.ts — pure selectors over the topic envelopes loaded from
// public/data/context/*.json. Mirrors the shape of src/lib/flowQueries.ts so
// the pattern is consistent across LEHD and context layers.

import type {
  ContextBundle,
  ContextCountyEntry,
  ContextEnvelope,
  ContextPlaceEntry,
  ContextStateEntry,
  ContextTopic,
} from '../types/context';

export function getEnvelope(bundle: ContextBundle, topic: ContextTopic): ContextEnvelope {
  return bundle[topic];
}

export function getStateContext(
  bundle: ContextBundle,
  topic: ContextTopic,
): ContextStateEntry | null {
  return bundle[topic].state;
}

export function getCountyContext(
  bundle: ContextBundle,
  topic: ContextTopic,
  geoid: string,
): ContextCountyEntry | null {
  const env = bundle[topic];
  return env.counties.find((c) => c.geoid === geoid) ?? null;
}

export function getPlaceContext(
  bundle: ContextBundle,
  topic: ContextTopic,
  zip: string,
): ContextPlaceEntry | null {
  const env = bundle[topic];
  return env.places.find((p) => p.zip === zip) ?? null;
}

/**
 * For an anchor ZIP, return its place entry plus its containing county and
 * the state entry — the comparison rails the per-anchor cards render.
 */
export function getPlaceWithRails(
  bundle: ContextBundle,
  topic: ContextTopic,
  zip: string,
): {
  place: ContextPlaceEntry | null;
  county: ContextCountyEntry | null;
  state: ContextStateEntry | null;
} {
  const place = getPlaceContext(bundle, topic, zip);
  const county = place ? getCountyContext(bundle, topic, place.countyGeoid) : null;
  const state = bundle[topic].state;
  return { place, county, state };
}

/**
 * Whether a topic has any data at any geographic level. Used by the toggle
 * to dim topics whose JSONs are still empty so users aren't promised data
 * that isn't there.
 */
export function hasData(env: ContextEnvelope): boolean {
  if (env.state?.latest) return true;
  if (env.counties.some((c) => c.latest)) return true;
  if (env.places.some((p) => p.latest)) return true;
  return false;
}

/** All sources across every topic, deduped by id, for the methodology footer. */
export function collectSources(bundle: ContextBundle): ContextEnvelope['sources'] {
  const seen = new Map<string, ContextEnvelope['sources'][number]>();
  for (const topic of Object.keys(bundle) as ContextTopic[]) {
    for (const s of bundle[topic].sources) {
      if (!seen.has(s.id)) seen.set(s.id, s);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.agency.localeCompare(b.agency));
}
