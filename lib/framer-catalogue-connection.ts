/** Server-side only. This stage reads the isolated trial; it never writes or publishes. */
type ProbeEnvironment = Record<string, string | undefined>;
type CmsField = { id: string; name: string; type: string; collectionId?: string };
type CmsItem = { id: string; nodeId?: string; slug: string; draft: boolean; fieldData: Readonly<Record<string, unknown>> };
type ReadCollection = { id: string; name: string; getFields(): Promise<CmsField[]>; getItems(): Promise<CmsItem[]> };
export type FramerReadClient = {
  getProjectInfo(): Promise<{ name: string; id: string }>;
  getCollection(id: string): Promise<ReadCollection | null>;
  disconnect(): Promise<void>;
};
type Connector = (project: string, key: string) => Promise<FramerReadClient>;

// Fixed targets prevent a browser or environment typo from redirecting this test to live CMS data.
export const framerCatalogueTrial = {
  projectId: "HSoQpURWMbVB013b2Lkg",
  serverProjectId: "72c852372068e038ec60ace295bb5ed9f1ce95b935eb6be5792e0fc1c416781d",
  projectUrl: "https://framer.com/projects/Moving-Modesty--HSoQpURWMbVB013b2Lkg-6iAuo",
  family: { id: "kgoPqzdgj", name: "CatalogueTrial", itemId: "Pd8cq0BT9", slug: "test-noor-active-hijab" },
  colours: { id: "CmYocN8y4", name: "CatalogueTrialColours", itemIds: ["QIXDKa9tL", "b3JRwCwT5"] },
} as const;

const familyFields = { IfyAamPkQ: "string", FwwB_jdGf: "string", QCD37mBss: "image", JwOrGbD1G: "string", PG6hyVIXQ: "string", nfm6rxF_n: "boolean" };
const colourFields = { di_ZSgtJG: "string", yKyjhVbqc: "image", Q88VSOk0y: "string", jOEelNszs: "string", MGJsDjY4H: "string", pYtPN6BbP: "collectionReference" };

export class FramerCatalogueConnectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "FramerCatalogueConnectionError"; this.code = code; }
}

export function framerCatalogueProbeEnabled(environment: ProbeEnvironment) {
  return environment.FRAMER_CATALOGUE_PROBE_ENABLED === "true" && environment.VERCEL_ENV !== "production"
    && (environment.NODE_ENV !== "production" || environment.VERCEL_ENV === "preview");
}

export function framerCatalogueProbeConfig(environment: ProbeEnvironment) {
  if (typeof window !== "undefined") throw new FramerCatalogueConnectionError("SERVER_ONLY", "The Framer connection is only available on the server.");
  if (!framerCatalogueProbeEnabled(environment)) throw new FramerCatalogueConnectionError("DISABLED", "The read-only Framer trial check is disabled. It cannot run in Production.");
  const key = environment.FRAMER_API_KEY?.trim();
  if (!key) throw new FramerCatalogueConnectionError("NOT_CONFIGURED", "Add the private FRAMER_API_KEY to the local environment before checking the connection.");
  const configuredProject = environment.FRAMER_PROJECT_URL?.trim() || framerCatalogueTrial.projectUrl;
  if (configuredProject !== framerCatalogueTrial.projectId && configuredProject !== framerCatalogueTrial.projectUrl) {
    throw new FramerCatalogueConnectionError("WRONG_PROJECT", "This check is restricted to the Moving Modesty trial project.");
  }
  return { project: configuredProject, key };
}

async function defaultConnector(project: string, key: string): Promise<FramerReadClient> {
  const { connect } = await import("framer-api");
  return connect(project, key);
}

function safeConnectionError(error: unknown): FramerCatalogueConnectionError {
  if (error instanceof FramerCatalogueConnectionError) return error;
  // Do not expose SDK errors, URLs, response bodies, credentials or stack traces in output.
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (["UNAUTHORIZED", "FORBIDDEN", "AUTHENTICATION_FAILED", "PERMISSION_DENIED"].includes(code)) {
    return new FramerCatalogueConnectionError("ACCESS_DENIED", "Framer rejected the connection. Check that the key belongs to Moving Modesty and has not been revoked.");
  }
  return new FramerCatalogueConnectionError("CONNECTION_FAILED", "Framer could not be checked. Verify the private key, project access and network connection, then try again.");
}

function collectionReferenceSlug(item: CmsItem, fieldId: string): string | undefined {
  const entry = item.fieldData[fieldId];
  if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "collectionReference"
    || !("value" in entry) || typeof entry.value !== "string") return undefined;
  return entry.value;
}

export async function checkFramerCatalogueConnection(environment: ProbeEnvironment, options: { connector?: Connector; timeoutMs?: number } = {}) {
  const configuration = framerCatalogueProbeConfig(environment);
  const deadline = Date.now() + (options.timeoutMs ?? 20000);
  let client: FramerReadClient | undefined;
  let expired = false;
  async function bounded<T>(pending: Promise<T>, timeoutMs = deadline - Date.now()): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FramerCatalogueConnectionError("TIMEOUT", "The Framer connection check timed out. Nothing was published or edited.")), Math.max(1, timeoutMs));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  try {
    const pendingConnection = (options.connector ?? defaultConnector)(configuration.project, configuration.key);
    // A late handshake must not leave a session open or continue reading after a timeout.
    void pendingConnection.then(lateClient => { if (expired) return lateClient.disconnect().catch(() => undefined); }, () => undefined);
    client = await bounded(pendingConnection);
    const project = await bounded(client.getProjectInfo());
    const collections = [];
    const issues: string[] = [];
    const targets = [
      { ...framerCatalogueTrial.family, fields: familyFields },
      { ...framerCatalogueTrial.colours, fields: colourFields },
    ];
    let family: CmsItem | undefined;
    let colours: CmsItem[] = [];
    for (const target of targets) {
      if (Date.now() >= deadline) throw new FramerCatalogueConnectionError("TIMEOUT", "The Framer connection check timed out. Nothing was published or edited.");
      const collection = await bounded(client.getCollection(target.id));
      if (!collection || collection.id !== target.id || collection.name !== target.name) {
        issues.push(`The isolated ${target.name} collection could not be verified.`);
        continue;
      }
      const fields = await bounded(collection.getFields());
      const mismatches = Object.entries(target.fields).filter(([id, type]) => !fields.some(field => field.id === id && field.type === type));
      if (mismatches.length) issues.push(`${target.name} has ${mismatches.length} missing or changed trial fields.`);
      if (target.id === framerCatalogueTrial.colours.id && !fields.some(field => field.id === "pYtPN6BbP" && field.type === "collectionReference" && field.collectionId === framerCatalogueTrial.family.id)) {
        issues.push("The colour-to-product reference does not point to the isolated trial collection.");
      }
      const items = await bounded(collection.getItems());
      const summary = { name: collection.name, itemCount: items.length, draftCount: items.filter(item => item.draft === true).length };
      collections.push(summary);
      if (summary.draftCount !== summary.itemCount) issues.push(`${target.name} contains a record that is not a draft. This check will not change its status.`);
      if (target.id === framerCatalogueTrial.family.id) family = items.find(item => (item.nodeId ?? item.id) === framerCatalogueTrial.family.itemId && item.slug === framerCatalogueTrial.family.slug);
      else colours = items.filter(item => framerCatalogueTrial.colours.itemIds.some(id => id === (item.nodeId ?? item.id)));
    }
    if (!family) issues.push("The expected TEST Noor product was not found.");
    if (colours.length !== 2) issues.push("Both expected TEST colour records were not found.");
    // Unmanaged collections use slugs for SDK references, not canvas node IDs.
    // https://www.framer.com/developers/cms#reference-fields
    const validReference = (item: CmsItem) => collectionReferenceSlug(item, "pYtPN6BbP") === family?.slug;
    if (family && colours.some(item => !validReference(item))) issues.push("A TEST colour is not linked to the expected product.");
    return {
      connected: true, trialReady: issues.length === 0, readOnly: true, publishingEnabled: false,
      checkedAt: new Date().toISOString(), projectName: project.name, collections, issues,
      nextStep: issues.length ? "Resolve the trial checks before enabling any CMS writes." : "Read access verified. This check does not save or publish products.",
    };
  } catch (error) { throw safeConnectionError(error); }
  finally {
    expired = true;
    if (client) {
      try { await bounded(client.disconnect(), 2000); }
      catch { throw new FramerCatalogueConnectionError("CLEANUP_FAILED", "The Framer check could not confirm that its session closed. Wait before trying again; nothing was published or edited."); }
    }
  }
}
