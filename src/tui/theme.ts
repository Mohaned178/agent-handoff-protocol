// The app's palette (spec "Palette"): black and green, one accent, red and amber only for a failure or a wait. Components
// take a token, never a raw colour, so the colour mode is decided once: truecolor, the 256-colour fallback, or none at all
// (`NO_COLOR`, `TERM=dumb`, no TTY), where the symbols ✓ ✗ ↻ ! ○ carry the meaning alone.

import { createContext, useContext } from "react";

export const TOKENS = ["bg", "surface", "border", "accent", "text", "muted", "added", "removed", "warn", "error"] as const;
export type Token = (typeof TOKENS)[number];

/** Each token's truecolor value and its 256-colour fallback, as the spec's table gives them. */
export const PALETTE: Readonly<Record<Token, { truecolor: string; ansi256: number }>> = {
  bg: { truecolor: "#000000", ansi256: 16 },
  surface: { truecolor: "#0c1a11", ansi256: 233 },
  border: { truecolor: "#1d3b28", ansi256: 236 },
  accent: { truecolor: "#22e07a", ansi256: 41 },
  text: { truecolor: "#d4f7e0", ansi256: 194 },
  muted: { truecolor: "#5e8f72", ansi256: 65 },
  added: { truecolor: "#22e07a", ansi256: 41 },
  removed: { truecolor: "#ff6b6b", ansi256: 203 },
  warn: { truecolor: "#f5c451", ansi256: 221 },
  error: { truecolor: "#ff5f56", ansi256: 203 },
};

/** The symbols that carry a state's meaning with or without colour. */
export const SYMBOLS = { ok: "✓", fail: "✗", retry: "↻", wait: "!", pending: "○", caret: "❯" } as const;

export type ColorMode = "truecolor" | "ansi256" | "none";

/**
 * How the terminal gets its colours. None under `NO_COLOR` (any non-empty value, as no-color.org says), `TERM=dumb` or
 * without a TTY; truecolor when `COLORTERM` says so, or in Windows Terminal (`WT_SESSION`), which draws 24-bit colour;
 * otherwise the 256-colour fallback.
 */
export function colorModeOf(env: Readonly<Record<string, string | undefined>>, isTTY: boolean): ColorMode {
  if ((env.NO_COLOR ?? "") !== "" || env.TERM === "dumb" || !isTTY) return "none";
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit" || (env.WT_SESSION ?? "") !== "") return "truecolor";
  return "ansi256";
}

export interface Theme {
  mode: ColorMode;
  /** A token's colour as Ink takes it (`color`, `backgroundColor`), or undefined when nothing is coloured. */
  color: (token: Token) => string | undefined;
  /** Whether bold may be used: with no colour, no styling escape is written at all. */
  bold: boolean;
  /** False under `AHP_NO_ANIMATION=1`: the spinner stands still. */
  animate: boolean;
}

export function themeFor(mode: ColorMode, animate = true): Theme {
  return {
    mode,
    color: (token) => (mode === "none" ? undefined : mode === "truecolor" ? PALETTE[token].truecolor : `ansi256(${PALETTE[token].ansi256})`),
    bold: mode !== "none",
    animate,
  };
}

/** The theme for this process's terminal: its environment, and whether stdout is a TTY. */
export function themeOf(env: Readonly<Record<string, string | undefined>>, isTTY: boolean): Theme {
  return themeFor(colorModeOf(env, isTTY), env.AHP_NO_ANIMATION !== "1");
}

export const ThemeContext = createContext<Theme>(themeFor("none"));

export const useTheme = (): Theme => useContext(ThemeContext);
