export { CHECK_IDS, ConformanceRefusedError, runConformance, type ConformanceOptions } from "./run.ts";
export {
  CHECK_STATUSES,
  ConformanceResultSchema,
  MOCK_TOOL_VERSION,
  OS_LABELS,
  SUITE_VERSION,
  osLabelOf,
  outcomeOf,
  type CheckResult,
  type CheckStatus,
  type ConformanceResult,
  type OsLabel,
} from "./result.ts";
export { SCENARIOS, type ConformanceSubject, type Provoked, type Provoker, type ProvokerContext, type Scenario, type ToldUsage } from "./subject.ts";
export { matrixOf, readResults, recordResult, renderMatrix, resultFileName, type CellStatus, type MatrixCell } from "./matrix.ts";
