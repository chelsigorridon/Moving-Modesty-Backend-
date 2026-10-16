import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { bobGoRequest } from "@/lib/integrations/bobgo/client";
import { parseLocation, record, textValue } from "@/lib/integrations/bobgo/protocol";

export function OPTIONS() { return apiOptions(); }
export async function GET(request: Request) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const query = (new URL(request.url).searchParams.get("q") || "").trim();
  if (query.length < 2 || query.length > 100 || /[\u0000-\u001f]/.test(query)) return apiJson({ error: "Search using at least two letters of the place name, suburb or postcode." }, { status: 400 });
  try {
    // Public locations only: no geocoder, private address, rates or booking.
    const result = await bobGoRequest("/locations?min_lat=-35&max_lat=-22&min_lng=16&max_lng=33");
    const points = new Map<string, { id: string; providerSlug: string; name: string; description: string; type: string }>();
    const search = query.toLocaleLowerCase();
    function walk(value: unknown) {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      const item = record(value), id = textValue(item.id ?? item.location_id), provider = textValue(item.provider_slug);
      if (item.active === true && ["locker", "counter"].includes(textValue(item.type)) && /^[1-9]\d*$/.test(id) && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(provider)) {
        try {
          const parsed = parseLocation([item], id, provider, false);
          const description = [parsed.address.street_address, parsed.address.local_area, parsed.address.city, parsed.address.code].filter(Boolean).join(", ");
          const name = parsed.name || description;
          if (`${name} ${description} ${provider}`.toLocaleLowerCase().includes(search)) points.set(`${provider}:${id}`, { id, providerSlug: provider, name, description, type: textValue(item.type) });
        } catch { /* Exclude unsupported or incomplete points. */ }
      }
      Object.values(item).forEach(child => { if (child && typeof child === "object") walk(child); });
    }
    walk(result);
    return apiJson({ points: [...points.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100), limited: points.size > 100 });
  } catch (error) {
    const reference = error && typeof error === "object" && "errorRef" in error ? error.errorRef : undefined;
    return apiJson({ error: "Bob Go pickup points could not be loaded. Try again shortly.", errorRef: reference }, { status: 502 });
  }
}
