export const FEATURE_ICONS: Record<
  string,
  { path: string; viewBox: string; color?: string }
> = {
  door: {
    path: "M4 2h8v12H4z M8 8h1v2H8z",
    viewBox: "0 0 16 16",
  },
  secret_door: {
    path: "M4 2h8v12H4z M6 6h4v4H6z",
    viewBox: "0 0 16 16",
  },
  locked_door: {
    path: "M4 2h8v12H4z M7 6h2v1H7z M6 7h4v3H6z",
    viewBox: "0 0 16 16",
  },
  trap: {
    path: "M8 1L1 15h14z M7 6h2v5H7z M7 12h2v2H7z",
    viewBox: "0 0 16 16",
  },
  treasure: {
    path: "M3 6h10v8H3z M2 6h12v2H2z M6 4h4v2H6z",
    viewBox: "0 0 16 16",
  },
  stairs_up: {
    path: "M2 14h3v-3h3v-3h3v-3h3V2",
    viewBox: "0 0 16 16",
  },
  stairs_down: {
    path: "M2 2h3v3h3v3h3v3h3v3",
    viewBox: "0 0 16 16",
  },
};
