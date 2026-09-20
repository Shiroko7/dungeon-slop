import { useSyncExternalStore } from "react";

/**
 * A router for a closed route space.
 *
 * Six patterns, all owned here, so this is about forty lines over the History
 * API rather than a dependency. If the space ever opens up — nested layouts,
 * lazy segments, route-level data loading — swap in `wouter`; the `Route` union
 * below is the only thing the rest of the app knows about.
 */
export type Route =
  | { view: "picker" }
  | { view: "campaign"; campaignId: number }
  | { view: "notes"; campaignId: number }
  | { view: "usage"; campaignId: number }
  | { view: "chat"; campaignId: number; chatId: number }
  | {
      view: "dungeon";
      campaignId: number;
      dungeonId: number;
      roomId: number | null;
    }
  | { view: "unknown"; path: string };

const PATTERNS: Array<[RegExp, (m: RegExpExecArray) => Route]> = [
  [/^\/?$/, () => ({ view: "picker" })],
  [/^\/c\/(\d+)\/?$/, (m) => ({ view: "campaign", campaignId: Number(m[1]) })],
  [
    /^\/c\/(\d+)\/notes\/?$/,
    (m) => ({ view: "notes", campaignId: Number(m[1]) }),
  ],
  [
    /^\/c\/(\d+)\/usage\/?$/,
    (m) => ({ view: "usage", campaignId: Number(m[1]) }),
  ],
  [
    /^\/c\/(\d+)\/chat\/(\d+)\/?$/,
    (m) => ({ view: "chat", campaignId: Number(m[1]), chatId: Number(m[2]) }),
  ],
  [
    /^\/c\/(\d+)\/d\/(\d+)\/?$/,
    (m) => ({
      view: "dungeon",
      campaignId: Number(m[1]),
      dungeonId: Number(m[2]),
      roomId: null,
    }),
  ],
  [
    /^\/c\/(\d+)\/d\/(\d+)\/r\/(\d+)\/?$/,
    (m) => ({
      view: "dungeon",
      campaignId: Number(m[1]),
      dungeonId: Number(m[2]),
      roomId: Number(m[3]),
    }),
  ],
];

export function parseRoute(pathname: string): Route {
  for (const [pattern, build] of PATTERNS) {
    const match = pattern.exec(pathname);
    if (match !== null) return build(match);
  }
  return { view: "unknown", path: pathname };
}

// ─── path builders ────────────────────────────────────────────────────────────
//
// Every link in the app goes through one of these, so a route shape can change
// in one place instead of in every template string that happened to know it.

export const paths = {
  picker: (): string => "/",
  campaign: (campaignId: number): string => `/c/${campaignId}`,
  notes: (campaignId: number): string => `/c/${campaignId}/notes`,
  usage: (campaignId: number): string => `/c/${campaignId}/usage`,
  chat: (campaignId: number, chatId: number): string =>
    `/c/${campaignId}/chat/${chatId}`,
  dungeon: (campaignId: number, dungeonId: number): string =>
    `/c/${campaignId}/d/${dungeonId}`,
  room: (campaignId: number, dungeonId: number, roomId: number): string =>
    `/c/${campaignId}/d/${dungeonId}/r/${roomId}`,
};

/** Which campaign a route belongs to, or null at the picker. */
export function campaignOf(route: Route): number | null {
  return route.view === "picker" || route.view === "unknown"
    ? null
    : route.campaignId;
}

// ─── navigation ───────────────────────────────────────────────────────────────

const NAVIGATION_EVENT = "dungeon-slop:navigate";

const listeners = new Set<() => void>();
let navigationEpoch = 0;
if (typeof window !== "undefined")
  window.addEventListener("popstate", () => {
    navigationEpoch++;
  });

/** Guard follow-up navigation after an asynchronous create/delete/fork. */
export function captureNavigation(): () => boolean {
  const epoch = navigationEpoch;
  const path = window.location.pathname;
  return () => navigationEpoch === epoch && window.location.pathname === path;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function navigate(
  path: string,
  options: { replace?: boolean } = {},
): void {
  if (path === window.location.pathname) return;
  navigationEpoch++;
  if (options.replace === true) {
    window.history.replaceState(null, "", path);
  } else {
    window.history.pushState(null, "", path);
  }
  emit();
}

export function subscribeNavigation(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  window.addEventListener(NAVIGATION_EVENT, listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
    window.removeEventListener(NAVIGATION_EVENT, listener);
  };
}

/**
 * The snapshot has to be referentially stable between navigations —
 * `useSyncExternalStore` compares by identity and would loop forever on a fresh
 * object every read. So the parsed route is cached against the path it came from.
 */
let cachedPath: string | null = null;
let cachedRoute: Route = { view: "picker" };

function getSnapshot(): Route {
  const path = window.location.pathname;
  if (path !== cachedPath) {
    cachedPath = path;
    cachedRoute = parseRoute(path);
  }
  return cachedRoute;
}

/** Server-render fallback; the app is client-only, but the hook demands one. */
function getServerSnapshot(): Route {
  return { view: "picker" };
}

export function useRoute(): Route {
  return useSyncExternalStore(
    subscribeNavigation,
    getSnapshot,
    getServerSnapshot,
  );
}

/**
 * An anchor that navigates without a full page load. Plain left-clicks are
 * intercepted; modified clicks (new tab, new window, download) are left alone,
 * because breaking those is the classic single-page-app regression.
 */
export function linkProps(href: string): {
  href: string;
  onClick: (e: React.MouseEvent<HTMLAnchorElement>) => void;
} {
  return {
    href,
    onClick: (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(href);
    },
  };
}
