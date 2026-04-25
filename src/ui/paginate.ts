import { ButtonBuilder, ButtonStyle } from "discord.js";

export interface Pagination<T> {
  slice: T[];
  /** Clamped to [0, totalPages-1]. */
  page: number;
  totalPages: number;
}

/** Slice `items` into a page, clamping `page` to a valid range. totalPages
 * is at least 1 even when there are no items, so callers can render an
 * empty-state message without dividing by zero. */
export function paginate<T>(
  items: T[],
  pageSize: number,
  page: number,
): Pagination<T> {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * pageSize;
  return {
    slice: items.slice(start, start + pageSize),
    page: safePage,
    totalPages,
  };
}

/** Prev/Next buttons that disable themselves at the edges. The caller passes
 * a function that maps a target page to its customId, so each view keeps
 * ownership of its routing scheme. */
export function buildPrevNext(
  page: number,
  totalPages: number,
  customIdFor: (targetPage: number) => string,
): ButtonBuilder[] {
  return [
    new ButtonBuilder()
      .setCustomId(customIdFor(page - 1))
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(customIdFor(page + 1))
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  ];
}
