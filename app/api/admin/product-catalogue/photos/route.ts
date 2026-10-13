import { apiJson, apiOptions } from "@/lib/api-response";
import { apiOriginAllowed } from "@/lib/api-security";
import { getRequestAdmin } from "@/lib/auth";
import { liveCatalogueEnabled } from "@/lib/catalogue-live";
import { withCatalogueFramer } from "@/lib/framer-catalogue-live";
import { reportFailure } from "@/lib/monitoring";

export const maxDuration = 60;
export const runtime = "nodejs";
export function OPTIONS() { return apiOptions(); }
export async function POST(request: Request) {
  if (!apiOriginAllowed(request)) return apiJson({ error: "Origin not allowed." }, { status: 403 });
  const admin = await getRequestAdmin(request);
  if (!admin || !["owner", "manager"].includes(admin.role)) return apiJson({ error: "Unauthorized" }, { status: 401 });
  if (!liveCatalogueEnabled()) return apiJson({ error: "Photo uploads have not been activated." }, { status: 503 });
  if (Number(request.headers.get("content-length")) > 4.2 * 1024 * 1024) return apiJson({ error: "Choose a photo under 4 MB." }, { status: 413 });
  const body = await request.formData().catch(() => null);
  const file = body?.get("photo");
  if (!(file instanceof File) || file.size > 4 * 1024 * 1024 || !file.size) return apiJson({ error: "Choose a JPG, PNG or WebP photo under 4 MB." }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP";
  const mimeType = jpeg ? "image/jpeg" : png ? "image/png" : webp ? "image/webp" : "";
  if (!mimeType || mimeType !== file.type) return apiJson({ error: "This file is not a supported photo." }, { status: 400 });
  try {
    const image = await withCatalogueFramer(client => client.uploadImage({ name: file.name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100), image: { bytes, mimeType } }));
    return apiJson({ photo: { url: image.url, alt: "" } });
  } catch (error) { const incident = await reportFailure(error, { operation: "admin_product" }); return apiJson({ error: "Photo upload failed. Try a smaller photo.", errorRef: incident.reference }, { status: 503 }); }
}
