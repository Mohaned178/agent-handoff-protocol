// The app's one animation. `AHP_NO_ANIMATION=1` stops it: the theme says so, and the spinner then shows a still dot.

import { useEffect, useState } from "react";
import { Text } from "ink";
import { h } from "../h.ts";
import { useTheme } from "../theme.ts";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const STILL = "•";
const INTERVAL_MS = 80;

export function Spinner({ label }: { label?: string }) {
  const theme = useTheme();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!theme.animate) return;
    const timer = setInterval(() => setFrame((current) => (current + 1) % SPINNER_FRAMES.length), INTERVAL_MS);
    return () => clearInterval(timer);
  }, [theme.animate]);
  return h(
    Text,
    null,
    h(Text, { color: theme.color("accent") }, theme.animate ? SPINNER_FRAMES[frame] : STILL),
    label ? h(Text, { color: theme.color("muted") }, ` ${label}`) : null,
  );
}
