// Session-kit helpers shared by server (prompt grounding) and web (kit dialog, handout).
// Facts come only from the Qloo entity; links are deterministic search URLs (no API keys).
import type { Domain, ScheduledSession } from "./types.ts";

/** Facts block for a session: Qloo entity data only, never model text. */
export interface KitFacts {
  name: string;
  domain: Domain;
  year?: number;
  description?: string;
  imageUrl?: string;
  /** Outings only. */
  address?: string;
  contentRating?: string;
  /** Up to 8 Qloo tag names. */
  tags: string[];
  /** Up to 6 related Qloo entity names. */
  related: string[];
}

const clean = (s: string | undefined, max: number) => {
  const t = s?.replace(/\s+/g, " ").trim();
  return t ? (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t) : undefined;
};

export function kitFacts(s: Pick<ScheduledSession, "entity" | "domain" | "related">): KitFacts {
  const e = s.entity;
  const p = e.properties ?? {};
  const year = typeof p.release_year === "number" && Number.isInteger(p.release_year) && p.release_year > 1000 && p.release_year < 2200 ? p.release_year : undefined;
  const imageUrl = e.image_url && /^https:\/\//i.test(e.image_url) ? e.image_url : undefined;
  return {
    name: e.name,
    domain: s.domain,
    ...(year ? { year } : {}),
    ...(clean(p.short_description, 600) ? { description: clean(p.short_description, 600) } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(s.domain === "outing" && clean(p.address, 200) ? { address: clean(p.address, 200) } : {}),
    ...(clean(p.content_rating, 20) ? { contentRating: clean(p.content_rating, 20) } : {}),
    tags: [...new Set((e.tags ?? []).map((t) => t.name.trim()).filter(Boolean))].slice(0, 8),
    related: (s.related ?? []).map((r) => r.name).filter(Boolean).slice(0, 6),
  };
}

export interface MediaLink {
  label: string;
  url: string;
}

const yt = (q: string) => `https://www.youtube.com/results?${new URLSearchParams({ search_query: q })}`;

/**
 * Deterministic search links for running the session. Only search pages on well-known public sites,
 * so nothing is guessed: staff pick the exact video or album.
 */
export function mediaLinks(s: Pick<ScheduledSession, "entity" | "domain">): MediaLink[] {
  const name = s.entity.name.trim();
  if (!name) return [];
  const year = s.entity.properties?.release_year;
  const withYear = year ? `${name} ${year}` : name;
  switch (s.domain) {
    case "music":
      return [
        { label: `YouTube: ${name} songs`, url: yt(`${name} songs`) },
        { label: `Spotify: ${name}`, url: `https://open.spotify.com/search/${encodeURIComponent(name)}` },
      ];
    case "film":
      return [{ label: `YouTube: ${withYear} trailer`, url: yt(`${withYear} trailer`) }];
    case "tv":
      return [
        { label: `YouTube: ${withYear} trailer`, url: yt(`${withYear} trailer`) },
        { label: `YouTube: ${name} opening theme`, url: yt(`${name} opening theme`) },
      ];
    case "books":
      return [
        { label: `Open Library: ${name}`, url: `https://openlibrary.org/search?${new URLSearchParams({ q: name })}` },
        { label: `WorldCat (find it in a library): ${name}`, url: `https://search.worldcat.org/search?${new URLSearchParams({ q: name })}` },
      ];
    case "gaming":
      return [{ label: `YouTube: ${name} gameplay`, url: yt(`${name} gameplay`) }];
    case "sports":
      return [{ label: `YouTube: ${name} highlights`, url: yt(`${name} highlights`) }];
    case "outing": {
      const address = s.entity.properties?.address?.trim();
      const loc = s.entity.location;
      const hasLoc = !!loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon) && Math.abs(loc.lat) <= 90 && Math.abs(loc.lon) <= 180;
      if (!address && !hasLoc) return [];
      // Name + address finds the venue itself; coordinates are the fallback when there is no address.
      const query = address ? `${name}, ${address}` : `${loc!.lat},${loc!.lon}`;
      return [
        { label: `Map: ${name}`, url: `https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query })}` },
        { label: `Directions to ${name}`, url: `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", destination: query })}` },
      ];
    }
  }
}
