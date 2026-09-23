import { startCase } from "lodash";

export function getModelDisplayName(modelKey: string): string {
  const formatted = startCase(modelKey.toLowerCase());
  return (
    formatted
      .replace(/(\d)\s+(\d)/g, "$1.$2")
      // startCase splits a version token ("V4" -> "V 4"); rejoin it.
      .replace(/\bV\s+(\d)/g, "V$1")
  );
}
