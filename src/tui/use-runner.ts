// The run this window started, as React sees it: it redraws when the runner says something about the run changed.

import { useCallback, useSyncExternalStore } from "react";
import type { ActiveRun, TaskRunner } from "./task-runner.ts";

export function useRunner(runner: TaskRunner): ActiveRun | null {
  const subscribe = useCallback((listener: () => void) => runner.subscribe(listener), [runner]);
  const snapshot = useCallback(() => runner.current(), [runner]);
  return useSyncExternalStore(subscribe, snapshot);
}
