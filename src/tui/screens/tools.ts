// `/tools` (spec D7): Node and git against their minimums and each coding tool with its version, login, adapter and declared
// levels on this OS, with the install or log-in command for one that is not ready. Read with `diagnose` (version and
// login-status commands only, never a prompt) on a spinner; `r` reads again. The body scrolls rather than clip.

import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { DoctorReport } from "../../doctor/doctor.ts";
import { Frame } from "../components/frame.ts";
import { bodyHeight, LinesView, scrollKeys } from "../components/lines.ts";
import { Spinner } from "../components/spinner.ts";
import { h } from "../h.ts";
import { dispatch, is, type KeyBinding } from "../keys.ts";
import type { Layout } from "../layout.ts";
import { commonKeys, type Nav } from "../nav.ts";
import { useTheme } from "../theme.ts";
import { toolsLines, toolsModel } from "../tools-model.ts";

export interface ToolsProps {
  layout: Layout;
  /** `diagnose`'s reading, kept a short while; `true` reads again. */
  tools: (refresh?: boolean) => Promise<DoctorReport>;
  nav: Nav;
  active: boolean;
}

type Loaded = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; report: DoctorReport };

export function Tools({ layout, tools, nav, active }: ToolsProps) {
  const theme = useTheme();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [offset, setOffset] = useState(0);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!active) return;
    let live = true;
    setLoaded({ state: "loading" });
    tools(round > 0).then(
      (report) => live && setLoaded({ state: "ready", report }),
      (error: unknown) => live && setLoaded({ state: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [active, tools, round]);

  const lines = loaded.state === "ready" ? toolsLines(toolsModel(loaded.report)) : [];
  const height = bodyHeight(layout.rows);
  const keys: KeyBinding[] = [
    ...scrollKeys(lines.length, height, offset, setOffset),
    { keys: "r", label: "check again", when: loaded.state !== "loading", match: is.char("r"), run: () => (setOffset(0), setRound((current) => current + 1)) },
    ...commonKeys(nav),
  ];
  useInput((input, key) => void dispatch(keys, input, key), { isActive: active });

  const body =
    loaded.state === "loading"
      ? h(Spinner, { label: "looking at the tools on this machine" })
      : loaded.state === "failed"
        ? h(Text, { color: theme.color("error"), wrap: "wrap" }, `The tools could not be checked: ${loaded.message}`)
        : h(LinesView, { lines, offset, height });
  return h(Frame, { layout, title: "tools", keys }, h(Box, { flexDirection: "column" }, body));
}
