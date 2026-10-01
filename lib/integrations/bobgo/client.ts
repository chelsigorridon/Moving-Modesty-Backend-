import "server-only";

import { getBobGoApiToken, getBobGoConfiguration } from "./configuration";

type NearbyLocationInput = {
  lat: number;
  lng: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
};

export type BobGoLocationMatch = Record<string, unknown>;

export type BobGoLocationLookup = {
  matches: BobGoLocationMatch[];
  response: unknown;
};

export class BobGoApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "BobGoApiError";
  }
}

async function bobGoRequest(path: string) {
  const config = getBobGoConfiguration();
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${getBobGoApiToken()}`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });

  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    throw new BobGoApiError(
      `Bob Go rejected the connection check (${response.status}).`,
      response.status,
    );
  }
  return body;
}

function locationMatches(value: unknown, targetName: string, matches: BobGoLocationMatch[]) {
  if (Array.isArray(value)) {
    value.forEach((item) => locationMatches(item, targetName, matches));
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const searchable = [
    record.name,
    record.location_name,
    record.display_name,
    record.address,
  ].filter((item): item is string => typeof item === "string").join(" ").toLowerCase();

  if (searchable.includes(targetName.toLowerCase())) matches.push(record);
  Object.values(record).forEach((item) => locationMatches(item, targetName, matches));
}

export async function findNearbyBobGoLocation(
  input: NearbyLocationInput,
  targetName = "Constantia Emporium",
): Promise<BobGoLocationLookup> {
  const query = new URLSearchParams({
    lat: input.lat.toString(),
    lng: input.lng.toString(),
    stacked_length: input.lengthCm.toString(),
    stacked_width: input.widthCm.toString(),
    stacked_height: input.heightCm.toString(),
    total_weight: input.weightKg.toString(),
  });
  const response = await bobGoRequest(`/locations?${query}`);
  const matches: BobGoLocationMatch[] = [];
  locationMatches(response, targetName, matches);
  return { matches, response };
}
