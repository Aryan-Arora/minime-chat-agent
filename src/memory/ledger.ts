import type { SnapshotChange, SnapshotValue } from "../types.js";

/** Structural diff keeps numeric changes numeric for the answer model to explain. */
export function diffSnapshots(
  before: Record<string, SnapshotValue>,
  after: Record<string, SnapshotValue>,
): SnapshotChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((key) =>
    Object.is(before[key], after[key])
      ? []
      : [{ key, ...(key in before ? { before: before[key] } : {}), ...(key in after ? { after: after[key] } : {}) }],
  );
}
