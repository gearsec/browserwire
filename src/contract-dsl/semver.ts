import type { VersionBump } from "./types";

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(value: string): ParsedSemver | null {
  const match = value.match(SEMVER_PATTERN);
  if (!match) {
    return null;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every((part) => Number.isInteger(part) && part >= 0)) {
    return null;
  }

  return { major, minor, patch };
}

export function isValidSemver(value: string): boolean {
  return parseSemver(value) !== null;
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) {
    throw new Error(`Invalid semver comparison: '${left}' vs '${right}'.`);
  }

  if (a.major !== b.major) {
    return a.major > b.major ? 1 : -1;
  }
  if (a.minor !== b.minor) {
    return a.minor > b.minor ? 1 : -1;
  }
  if (a.patch !== b.patch) {
    return a.patch > b.patch ? 1 : -1;
  }
  return 0;
}

export function detectVersionChange(
  previousVersion: string,
  nextVersion: string
): VersionBump | "downgrade" {
  const previous = parseSemver(previousVersion);
  const next = parseSemver(nextVersion);
  if (!previous || !next) {
    throw new Error(
      `Cannot detect version change for invalid semver values '${previousVersion}' and '${nextVersion}'.`
    );
  }

  if (next.major < previous.major) {
    return "downgrade";
  }
  if (next.major > previous.major) {
    return "major";
  }

  if (next.minor < previous.minor) {
    return "downgrade";
  }
  if (next.minor > previous.minor) {
    return "minor";
  }

  if (next.patch < previous.patch) {
    return "downgrade";
  }
  if (next.patch > previous.patch) {
    return "patch";
  }

  return "none";
}

export function isBumpAtLeast(actual: VersionBump | "downgrade", required: VersionBump): boolean {
  const order: Record<VersionBump | "downgrade", number> = {
    downgrade: -1,
    none: 0,
    patch: 1,
    minor: 2,
    major: 3
  };

  return order[actual] >= order[required];
}
