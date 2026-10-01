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

export async function bobGoRequest(path: string, input?: Record<string, unknown>) {
  const config = getBobGoConfiguration();
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method: input ? "POST" : "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${getBobGoApiToken()}`,
      ...(input ? { "Content-Type": "application/json" } : {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(input ? 30_000 : 15_000),
    ...(input ? { body: JSON.stringify(input) } : {}),
  });

  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    throw new BobGoApiError(
      `Bob Go rejected the request (${response.status}). Check the account balance, API access and courier setup in Bob Go.`,
      response.status,
    );
  }
  return body;
}

export async function getConfiguredBobGoLocation(parcel?: { lengthCm: number; widthCm: number; heightCm: number; weightGrams: number }) {
  const config = getBobGoConfiguration();
  if (!config.pickupPointLocationId || !config.pickupPointProviderSlug) throw new Error("The Bob Go drop-off location and provider must be configured.");
  const query = new URLSearchParams({ location_id: config.pickupPointLocationId, provider_slug: config.pickupPointProviderSlug });
  if (parcel) {
    query.set("stacked_length", String(parcel.lengthCm)); query.set("stacked_width", String(parcel.widthCm));
    query.set("stacked_height", String(parcel.heightCm)); query.set("total_weight", String(parcel.weightGrams / 1000));
  }
  return bobGoRequest(`/locations?${query}`);
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
