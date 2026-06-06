// Derive a lat/lon for an account from its serviceAddress using Open-Meteo's
// free geocoding API (no key). The network call is isolated in `geocode`; the
// address→query parsing and the response→coords normalization are pure and
// unit-tested.

export interface LatLon {
  latitude: number;
  longitude: number;
}

// Open-Meteo's geocoding response (only the fields we use).
interface GeoResult {
  latitude?: number;
  longitude?: number;
  name?: string;
}
interface GeoResponse {
  results?: GeoResult[];
}

// US ZIP (5-digit, optionally ZIP+4). Used both for the centroid fallback and
// to favor a ZIP-based geocode query, which Open-Meteo resolves reliably.
const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/;

// Pull a best-effort geocoder query string out of a free-form service address.
// Open-Meteo's geocoder matches place names / postal codes, not full street
// addresses, so prefer the ZIP when present and otherwise fall back to the
// first comma-delimited locality token. Pure.
export function geocodeQuery(serviceAddress: string | null | undefined): string | null {
  if (!serviceAddress) return null;
  const addr = serviceAddress.trim();
  if (!addr) return null;

  const zip = addr.match(ZIP_RE)?.[1];
  if (zip) return zip;

  // No ZIP: take the locality-ish part (drop a leading street line if present).
  const parts = addr
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  // Heuristic: a token starting with a house number is a street line — skip it.
  const locality = parts.find((p) => !/^\d/.test(p)) ?? parts[parts.length - 1];
  return locality || null;
}

// Normalize an Open-Meteo geocoding response to a single LatLon (the top hit),
// or null if there were no usable results. Pure.
export function pickGeoResult(resp: GeoResponse | null | undefined): LatLon | null {
  const hit = resp?.results?.find(
    (r) => typeof r.latitude === 'number' && typeof r.longitude === 'number'
  );
  if (!hit) return null;
  return { latitude: hit.latitude as number, longitude: hit.longitude as number };
}

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

// Geocode a service address to lat/lon. IMPURE (one HTTP GET). Returns null when
// the address can't be turned into a query or the geocoder finds nothing.
export async function geocode(serviceAddress: string | null | undefined): Promise<LatLon | null> {
  const query = geocodeQuery(serviceAddress);
  if (!query) return null;

  const url = new URL(GEOCODE_URL);
  url.searchParams.set('name', query);
  url.searchParams.set('count', '1');
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`geocode failed: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as GeoResponse;
  return pickGeoResult(json);
}
