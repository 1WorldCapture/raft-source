// Library surface for the whole-home process sweep (see src/homeProcessSweep.ts
// for the semantics). The Desktop host uses this before converging a home:
// orphaned __service/__run trees left by an interrupted handover must not
// survive next to a freshly started service (drill 290-anna-②a defect).
export {
  argvMentionsHome,
  defaultKillHomeProcess,
  defaultScanHomeProcesses,
  homeProcessSpellings,
  mentionsWithBoundary,
  sweepHomeProcesses,
  type HomeProcess,
  type HomeSweepDeps,
} from "../homeProcessSweep.js";
