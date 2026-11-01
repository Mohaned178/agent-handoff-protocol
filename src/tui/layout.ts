// What fits in the terminal: below 80×20 the app refuses (the plain commands still work); below 110 columns the panes
// and the sidebar fold.

export const MIN_COLUMNS = 80;
export const MIN_ROWS = 20;
export const WIDE_COLUMNS = 110;

export const TOO_SMALL = "Make the terminal at least 80×20, or use `ahp run`.";

export interface Layout {
  columns: number;
  rows: number;
  /** False below 80×20: the screen shows `TOO_SMALL` and nothing else. */
  fits: boolean;
  /** True from 110 columns: the sidebar and side-by-side panes show; below, they fold. */
  wide: boolean;
}

export function layoutOf(columns: number, rows: number): Layout {
  return { columns, rows, fits: columns >= MIN_COLUMNS && rows >= MIN_ROWS, wide: columns >= WIDE_COLUMNS };
}
