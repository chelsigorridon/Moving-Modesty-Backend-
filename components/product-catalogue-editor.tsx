"use client";

/* eslint-disable @next/next/no-img-element -- CMS and browser-only photo previews retain their exact image source. */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { catalogueDocumentSchema, type CatalogueDocument } from "@/lib/catalogue-input";
import { adminRequest } from "@/lib/admin-client";
import {
  addProductSize, catalogueEditorErrors, changeUsualPrice, newProductColour, productAddress,
  productAvailability, productSizes, renameProductSize, usualProductPrice, variantAvailable, withProductColours,
  type CatalogueEditorErrors,
} from "@/lib/catalogue-editor";

type Draft = { id?: string; revision: number; cmsVersion?: string; stockVersion?: string; publishedRevision?: number; publicationState?: string; publicationError?: string; pageUrl?: string; document: CatalogueDocument;
  stockReviewRequired?: boolean; stockRecoveryNotice?: string;
  stockConflicts?: Array<{ id: string; colour: string; size: string; currentStock: number; draftStock: number; currentStockVerified: boolean; draftStockVerified: boolean }> };
type Props = { demo?: boolean; initialProducts?: Draft[]; apiBaseUrl?: string; framerTrial?: boolean; live?: boolean };
type Colour = CatalogueDocument["colours"][number];
const money = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" });
const stages = ["Product details", "Colours & photos", "Preview"];

function newDocument(): CatalogueDocument {
  return { name: "", slug: "product", description: "", category: "Active hijabs", homepageImage: { url: "", alt: "" },
    showOnHomepage: true, homepageOrder: 0, colours: [newProductColour(["One size fits all"], 0)] };
}
function fieldAttributes(path: string, errors: CatalogueEditorErrors) {
  const describedBy = [path === "usualPrice" ? "hint-usualPrice" : "", errors[path] ? `error-${path.replaceAll(".", "-")}` : ""].filter(Boolean).join(" ");
  return { id: `product-${path.replaceAll(".", "-")}`, "aria-invalid": !!errors[path],
    "aria-describedby": describedBy || undefined };
}
function Field({ label, path, errors, hint, children }: { label: string; path: string; errors: CatalogueEditorErrors; hint?: string; children: ReactNode }) {
  return <div className="mm-products__field">
    <label htmlFor={`product-${path.replaceAll(".", "-")}`}>{label}</label>{children}{hint && <small id={`hint-${path.replaceAll(".", "-")}`}>{hint}</small>}
    {errors[path] && <small className="mm-products__field-error" id={`error-${path.replaceAll(".", "-")}`}>{errors[path]}</small>}
  </div>;
}

export default function ProductCatalogueEditor({ demo = false, initialProducts = [], apiBaseUrl = "", framerTrial = false, live = false }: Props) {
  const [products, setProducts] = useState<Draft[]>(initialProducts);
  const [current, setCurrent] = useState<Draft | null>(null);
  const [step, setStep] = useState(0);
  const [preview, setPreview] = useState(false);
  const [usualPrice, setUsualPrice] = useState("");
  const [errors, setErrors] = useState<CatalogueEditorErrors>({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!demo);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [stockReviewConfirmed, setStockReviewConfirmed] = useState(false);
  const saving = useRef(false);
  const focusErrors = useRef(false);
  const inputFile = useRef<HTMLInputElement>(null);
  const pendingColour = useRef<string | null>(null);
  const objectUrls = useRef<string[]>([]);
  const editor = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const base = apiBaseUrl.replace(/\/$/, "");
  const endpoint = live ? "/api/admin/product-catalogue" : framerTrial ? "/api/product-trial/framer" : "/api/admin/catalogue";
  const isNew = current !== null && !current.id;
  const document = current?.document;

  const headers = useCallback((): Record<string, string> => ({ "Content-Type": "application/json" }), []);
  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    adminRequest(`${base}${endpoint}`, { headers: headers(), signal: controller.signal, cache: "no-store" })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Products could not be loaded."); return data; })
      .then(data => { setProducts(data.products); setNeedsSetup(data.needsSetup === true); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, demo, endpoint, headers]);
  useEffect(() => () => objectUrls.current.forEach(url => URL.revokeObjectURL(url)), []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => { heading.current?.focus(); heading.current?.scrollIntoView({ block: "start" }); }, [step, current?.id, isNew, preview]);
  useEffect(() => {
    if (!focusErrors.current) return;
    focusErrors.current = false;
    const field = editor.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (field) {
      for (let parent = field.parentElement; parent; parent = parent.parentElement) if (parent.tagName === "DETAILS") (parent as HTMLDetailsElement).open = true;
      field.focus();
    }
  }, [errors]);

  function select(product: Draft | null) {
    if (dirty && !window.confirm("Leave without saving your changes?")) return;
    setCurrent(product ? structuredClone(product) : { revision: 0, document: newDocument() });
    const price = product ? usualProductPrice(product.document) : 0;
    setUsualPrice(price ? String(price) : ""); setStep(0); setPreview(false); setDirty(false);
    setErrors({}); setNotice(""); setError("");
    setStockReviewConfirmed(false);
  }
  function replace(document: CatalogueDocument) {
    setCurrent(previous => previous && { ...previous, document }); setDirty(true); setNotice("");
    setStockReviewConfirmed(false);
    const remaining = catalogueEditorErrors(document, demo);
    setErrors(previous => Object.fromEntries(Object.entries(previous).filter(([path]) =>
      path === "usualPrice" || (path === "description" && !document.description.trim()) || remaining[path])));
  }
  function patch(values: Partial<CatalogueDocument>) { if (document) replace({ ...document, ...values }); }
  function changeColour(id: string, change: (colour: Colour) => Colour) {
    if (document) replace(withProductColours(document, document.colours.map(colour => colour.id === id ? change(colour) : colour)));
  }
  function rename(name: string) { patch({ name, ...(isNew ? { slug: productAddress(name, products.map(product => product.document.slug)) } : {}) }); }
  function changePrice(value: string) {
    if (document) replace(changeUsualPrice(document, Number(usualPrice), Number(value)));
    setUsualPrice(value);
    const price = Number(value);
    if (value && Number.isFinite(price) && price > 0 && price <= 100000 && Math.abs(price * 100 - Math.round(price * 100)) < 0.00001) {
      setErrors(previous => Object.fromEntries(Object.entries(previous).filter(([path]) => path !== "usualPrice")));
    }
  }
  function next() {
    if (!document) return;
    let found = catalogueEditorErrors(document, demo);
    if (step === 0) {
      found = Object.fromEntries(Object.entries(found).filter(([path]) => ["name", "slug", "description"].includes(path) || path.endsWith(".size")));
      const price = Number(usualPrice);
      if (!usualPrice || !Number.isFinite(price) || price <= 0 || price > 100000 || Math.abs(price * 100 - Math.round(price * 100)) > 0.00001) found.usualPrice = "Enter a price between R0.01 and R100,000, with no more than two decimal places.";
      if (!document.description.trim()) found.description = "Add a short description of your product.";
    }
    focusErrors.current = true; setErrors(found); setError("");
    if (Object.keys(found).length) return;
    setStep(previous => Math.min(previous + 1, 2));
  }
  async function save(publish = false) {
    if (!current || saving.current) return;
    const found = catalogueEditorErrors(current.document, demo);
    const price = Number(usualPrice);
    if (!usualPrice || !Number.isFinite(price) || price <= 0 || price > 100000 || Math.abs(price * 100 - Math.round(price * 100)) > 0.00001) found.usualPrice = "Enter a price between R0.01 and R100,000, with no more than two decimal places.";
    focusErrors.current = true; setErrors(found); setError(""); setNotice("");
    if (Object.keys(found).length) {
      setPreview(false);
      if (isNew) setStep(Object.keys(found).some(path => ["name", "slug", "description", "usualPrice"].includes(path)) ? 0 : 1);
      return;
    }
    if (live && current.stockReviewRequired && !stockReviewConfirmed) {
      setError("Check the stock quantities and tick the stock confirmation before saving."); setPreview(false); return;
    }
    saving.current = true; setBusy(true);
    let stockOnlyPublished = false;
    try {
      let saved: Draft;
      if (demo) {
        if (products.some(product => product.document.slug === current.document.slug && product.id !== current.id)) throw new Error("A product with this name already exists. Please use a different name.");
        saved = { ...current, id: current.id || crypto.randomUUID(), revision: current.revision + 1 };
      } else {
        const checked = catalogueDocumentSchema.parse(current.document);
        const response = await adminRequest(`${base}${endpoint}`, { method: "POST", headers: headers(), body: JSON.stringify({ id: current.id, expectedRevision: current.revision, stockVersion: current.stockVersion, ...(live ? { stockReviewConfirmed } : {}), ...(framerTrial ? { expectedCmsVersion: current.cmsVersion } : {}), document: checked }), signal: AbortSignal.timeout(60000) });
        const data = await response.json();
        if (!response.ok) throw new Error(`${data.error || "Your changes could not be saved."}${data.errorRef ? ` Reference: ${data.errorRef}` : ""}`);
        if (framerTrial && (data.cmsSynced !== true || data.published !== false || !data.product?.cmsVersion)) throw new Error("Framer has not confirmed this TEST draft save. Your changes remain here; reload to check CMS before retrying.");
        saved = data.product;
      }
      // Keep the confirmed draft even if publication fails or times out.
      setCurrent(saved); setDirty(false);
      setStockReviewConfirmed(false);
      setProducts(previous => previous.some(product => product.id === saved.id) ? previous.map(product => product.id === saved.id ? saved : product) : [...previous, saved]);
      if (publish && live) {
        const response = await adminRequest(`${base}${endpoint}`, { method: "POST", headers: headers(), body: JSON.stringify({ action: "publish", id: saved.id, expectedRevision: saved.revision }), signal: AbortSignal.timeout(60000) });
        const data = await response.json();
        stockOnlyPublished = ["inventory", "unchanged"].includes(data.publicationTarget) && data.stockSynced === true;
        if (!response.ok || data.published !== true || (data.cmsSynced !== true && !stockOnlyPublished)) throw new Error(`${data.error || "Publication could not be verified. Your saved draft is retained."}${data.errorRef ? ` Reference: ${data.errorRef}` : ""}`);
        saved = data.product;
        setProducts(previous => previous.map(product => product.id === saved.id ? saved : product));
      }
      setCurrent(null); setDirty(false); setPreview(false); setStep(0);
      setNotice(publish && live ? stockOnlyPublished ? `${saved.document.name}: stock and availability updated.` : `${saved.document.name} published. Its page, collection card and checkout are connected.` : demo ? `${saved.document.name} saved for this demo. Refreshing will reset your changes.` : framerTrial ? "TEST draft saved and verified in Framer. The live website has not changed." : "Draft saved. The live website has not changed.");
    } catch (error) { setError(error instanceof Error ? error.message : "Your changes could not be saved. They are still in the editor."); }
    finally { saving.current = false; setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); if (isNew && step < 2) next(); else void save(live); }
  function leave() {
    if (dirty && !window.confirm("Leave without saving your changes?")) return;
    setCurrent(null); setDirty(false); setPreview(false); setErrors({}); setError(""); setNotice("");
  }
  function addPhotos(colourId: string | null) { pendingColour.current = colourId; inputFile.current?.click(); }
  async function acceptPhotos(files: FileList | null) {
    if (!files || !document) return;
    const selected = Array.from(files);
    if (selected.some(file => !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 4 * 1024 * 1024)) { setError("Choose JPG, PNG or WebP photos under 4 MB each."); return; }
    const colour = document.colours.find(colour => colour.id === pendingColour.current);
    if (colour && colour.photos.length + selected.length > 12) { setError("Each colour can have up to 12 photos. Remove a photo before adding more."); return; }
    const target = pendingColour.current;
    setBusy(true);
    try {
      const photos: Array<{ url: string; alt: string }> = [];
      for (const file of selected) {
        if (!live) { const url = URL.createObjectURL(file); objectUrls.current.push(url); photos.push({ url, alt: file.name }); }
        else {
          const body = new FormData(); body.set("photo", file);
          const response = await adminRequest(`${base}${endpoint}/photos`, { method: "POST", body, signal: AbortSignal.timeout(60000) });
          const data = await response.json();
          if (!response.ok || !data.photo?.url) throw new Error(data.error || "Photo upload failed.");
          photos.push(data.photo);
        }
      }
      if (target) changeColour(target, colour => ({ ...colour, photos: [...colour.photos, ...photos] }));
      else if (photos[0]) patch({ homepageImage: photos[0] });
      setError("");
    } catch (error) { setError(error instanceof Error ? error.message : "Photo upload failed."); }
    finally { setBusy(false); }
  }
  async function initialize() {
    setBusy(true); setError("");
    try { const response = await adminRequest(`${base}${endpoint}`, { method: "POST", headers: headers(), body: JSON.stringify({ action: "initialize" }), signal: AbortSignal.timeout(60000) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Existing products could not be connected.");
      setProducts(data.products); setNeedsSetup(false);
    } catch (error) { setError(error instanceof Error ? error.message : "Connection failed."); } finally { setBusy(false); }
  }
  const detailsProps = document && { document, usualPrice, errors, patch, rename, changePrice, replace };
  const colourProps = document && { document, demo: demo || live, errors, changeColour, addPhotos,
    removeColour: (id: string) => { if (document.colours.length > 1) replace(withProductColours(document, document.colours.filter(colour => colour.id !== id))); },
    addColour: () => { if (document.colours.length < 30) replace(withProductColours(document, [...document.colours, newProductColour(productSizes(document), Number(usualPrice))])); } };
  const stockProps = document && { document, demo, errors, changeColour };

  if (framerTrial) return <section className="mm-products" ref={editor}>
    <style dangerouslySetInnerHTML={{ __html: styles }} />
    <header className="mm-products__header"><div><p className="mm-products__eyebrow">MOVING MODESTY · UNPUBLISHED TEST</p><h1>Products</h1></div></header>
    <p className="mm-products__notice">Connected TEST draft. Save the name, description and tagline directly to Framer. Nothing is published or saved to live stock.</p>
    {notice && <p className="mm-products__success" role="status">{notice}</p>}
    {error && <p className="mm-products__error" role="alert">{error}</p>}
    {loading ? <p role="status">Loading TEST draft from Framer…</p> : !current ? <div className="mm-products__list">{products.map(product => <article className="mm-products__row" key={product.id}>
      <img src={product.document.homepageImage.url} alt="" />
      <div><h2>{product.document.name}</h2><p>{product.document.colours.length} colours · not for sale</p><span className="mm-products__badge">Framer draft</span></div>
      <button onClick={() => select(product)}>Edit product</button>
    </article>)}</div> : document && <>
      <button className="mm-products__back" disabled={busy} onClick={leave}>← Products</button>
      <div className="mm-products__title"><h2 ref={heading} tabIndex={-1}>Edit TEST product</h2><span>{dirty ? "Unsaved changes" : "Framer draft"}</span></div>
      <form onSubmit={submit} noValidate><fieldset disabled={busy} className="mm-products__form"><div className="mm-products__section">
        <Field label="Product name" path="name" errors={errors} hint="Keep TEST at the start of the name."><input {...fieldAttributes("name", errors)} value={document.name} onChange={event => rename(event.target.value)} maxLength={200} /></Field>
        <Field label="Description" path="description" errors={errors}><textarea {...fieldAttributes("description", errors)} rows={4} value={document.description} onChange={event => patch({ description: event.target.value })} maxLength={10000} /></Field>
        <Field label="Collection tagline" path="tagline" errors={errors} hint="Keep UNPUBLISHED TEST in the tagline."><input {...fieldAttributes("tagline", errors)} value={document.tagline ?? ""} onChange={event => patch({ tagline: event.target.value })} maxLength={300} /></Field>
        <p>Read-only for this first test: {document.colours.map(colour => colour.name).join(" & ")} · {productSizes(document).join(" / ")} · {money.format(usualProductPrice(document))}. Photos, prices, colours and stock are not editable yet.</p>
      </div><footer className="mm-products__footer"><span>Unpublished draft only</span><button className="mm-products__primary" type="submit">{busy ? "Saving…" : "Save draft"}</button></footer></fieldset></form>
    </>}
  </section>;

  return <section className="mm-products" ref={editor}>
    <style dangerouslySetInnerHTML={{ __html: styles }} />
    <header className="mm-products__header"><div><p className="mm-products__eyebrow">MOVING MODESTY</p><h1>Products</h1></div>
      {!current && <button className="mm-products__primary" disabled={loading || busy || needsSetup} onClick={() => select(null)}>Add product</button>}</header>
    <p className="mm-products__notice">{live ? "Save a draft while you prepare. Publish when you’re ready for customers to see the changes." : demo ? "Demo only. Changes stay in this window and don’t affect your website." : "Draft trial. Changes are saved as drafts, not published to your website."}</p>
    {notice && <p className="mm-products__success" role="status">{notice}</p>}
    {error && <p className="mm-products__error" role="alert">{error}</p>}
    <input ref={inputFile} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={event => { void acceptPhotos(event.target.files); event.target.value = ""; }} />
    {needsSetup && <div className="mm-products__section"><p>Connect the existing Amina and Hawa products once. Their live pages and stock won’t be changed.</p><button disabled={busy} onClick={() => void initialize()}>{busy ? "Connecting…" : "Connect existing products"}</button></div>}
    {loading ? <p role="status">Loading products…</p> : !current ? <div className="mm-products__list">
      {products.length === 0 && <p>No products yet. Choose Add product to get started.</p>}
      {products.map(product => <article className="mm-products__row" key={product.id}>
        {product.document.homepageImage.url ? <img src={product.document.homepageImage.url} alt="" /> : <span className="mm-products__placeholder">M</span>}
        <div><h2>{product.document.name}</h2><p>{product.document.colours.length} colours</p><span className="mm-products__badge">{live ? product.publicationState !== "idle" ? "Publication needs checking" : product.publishedRevision === product.revision ? "Published" : "Draft changes" : productAvailability(product.document) + (demo ? " · demo" : " · draft")}</span>{product.publicationError && <p role="alert">{product.publicationError}</p>}{live && product.publishedRevision ? <p><a href={product.pageUrl} target="_blank" rel="noreferrer">View product page ↗</a></p> : null}</div>
        <button onClick={() => select(product)}>Edit product</button>
      </article>)}
    </div> : document && <>
      <button className="mm-products__back" disabled={busy} onClick={leave}>← Products</button>
      {isNew && <ol className="mm-products__steps" aria-label="Add product steps">{stages.map((stage, index) => <li key={stage} aria-current={step === index ? "step" : undefined}><span>{index + 1}</span>{stage}</li>)}</ol>}
      <div className="mm-products__title"><h2 ref={heading} tabIndex={-1}>{isNew ? stages[step] : preview ? `Preview ${document.name}` : document.name}</h2><span>{dirty ? "Unsaved changes" : demo ? "Demo copy" : "Draft"}</span></div>
      <form onSubmit={submit} noValidate>
        <fieldset disabled={busy} className="mm-products__form">
          {live && current.stockRecoveryNotice && <div className="mm-products__section" aria-label="Stock update review">
            <p role="status">{current.stockRecoveryNotice}</p>
            {current.stockReviewRequired && <>
              <ul>{current.stockConflicts?.map(entry => <li key={entry.id}>{entry.colour} · {entry.size}: current stock {entry.currentStockVerified ? entry.currentStock : "not counted"}; saved draft {entry.draftStockVerified ? entry.draftStock : "not counted"}.</li>)}</ul>
              <p>Check Stock &amp; availability against your physical stock and correct any quantities.</p>
              <label className="mm-products__check"><input type="checkbox" checked={stockReviewConfirmed} onChange={event => setStockReviewConfirmed(event.target.checked)} />I have checked these quantities against my physical stock.</label>
            </>}
          </div>}
          {isNew ? step === 0 ? <DetailsFields {...detailsProps!} /> : step === 1 ? <>
            <ColourFields {...colourProps!} />
            <details className="mm-products__accordion" open><summary>Stock & availability</summary><StockFields {...stockProps!} /></details>
          </> : <Preview document={document} demo={demo || live} patch={patch} addPhotos={addPhotos} /> : preview ? <Preview document={document} demo={demo || live} patch={patch} addPhotos={addPhotos} /> : <>
            <p className="mm-products__intro">Choose what you want to change.</p>
            <details className="mm-products__accordion"><summary>Product details <small>Name, description, price & sizes</small></summary><DetailsFields {...detailsProps!} /></details>
            <details className="mm-products__accordion"><summary>Colours & photos <small>Colour names and their images</small></summary><ColourFields {...colourProps!} /></details>
            <details className="mm-products__accordion" open={current.stockReviewRequired || undefined}><summary>Stock & availability <small>Quantities and what customers can buy</small></summary><StockFields {...stockProps!} /></details>
          </>}
          <footer className="mm-products__footer">
            <div>{isNew && step > 0 ? <button type="button" onClick={() => { setStep(previous => previous - 1); setErrors({}); }}>Back</button> : !isNew && <button type="button" onClick={() => setPreview(!preview)}>{preview ? "Back to editing" : "Preview"}</button>}</div>
            {live && (!isNew || step === 2) && <button type="button" onClick={() => void save(false)}>Save draft</button>}
            <button className="mm-products__primary" type="submit">{busy ? "Working…" : isNew && step < 2 ? "Continue" : live ? "Publish" : demo ? isNew ? "Save demo product" : "Save demo changes" : "Save draft"}</button>
          </footer>
        </fieldset>
      </form>
    </>}
  </section>;
}

type DetailsProps = {
  document: CatalogueDocument; usualPrice: string; errors: CatalogueEditorErrors;
  patch: (values: Partial<CatalogueDocument>) => void; rename: (value: string) => void;
  changePrice: (value: string) => void; replace: (document: CatalogueDocument) => void;
};
function DetailsFields({ document, usualPrice, errors, patch, rename, changePrice, replace }: DetailsProps) {
  // Keep duplicate rows visible during typing so validation can explain and fix them.
  const sizes = document.colours[0].variants.map(entry => entry.size);
  return <div className="mm-products__section">
    <Field label="Product name" path="name" errors={errors}><input {...fieldAttributes("name", errors)} value={document.name} onChange={event => rename(event.target.value)} placeholder="e.g. Noor Active Hijab" maxLength={200} /></Field>
    <Field label="Description" path="description" errors={errors}><textarea {...fieldAttributes("description", errors)} rows={3} value={document.description} onChange={event => patch({ description: event.target.value })} placeholder="What should customers know about this product?" maxLength={10000} /></Field>
    <Field label="Usual price (R)" path="usualPrice" errors={errors} hint="Used for new colours and sizes. Any different prices you set are kept."><input {...fieldAttributes("usualPrice", errors)} type="number" min="0.01" max={100000} step="0.01" inputMode="decimal" value={usualPrice} onChange={event => changePrice(event.target.value)} placeholder="e.g. 420" /></Field>
    <div className="mm-products__sizes"><h3>Sizes</h3><p>Leave one size, or add the sizes this product comes in.</p>
      {document.colours[0].variants.map((entry, index) => {
        const path = `colours.0.variants.${index}.size`;
        return <div className="mm-products__size" key={entry.id}><Field label={`Size ${index + 1}`} path={path} errors={errors}><input {...fieldAttributes(path, errors)} value={entry.size} maxLength={80} onChange={event => replace(renameProductSize(document, entry.size, event.target.value, index))} /></Field>
          {sizes.length > 1 && <button type="button" disabled={document.colours.some(colour => colour.variants.length === 1)} aria-label={`Remove size ${entry.size || index + 1}`} onClick={() => replace({ ...document, colours: document.colours.map(colour => ({ ...colour, variants: colour.variants.filter((variant, position) => position !== index || variant.size !== entry.size) })) })}>Remove</button>}</div>;
      })}
      <button type="button" disabled={document.colours.some(colour => colour.variants.length >= 30)} onClick={() => {
        let name = "New size";
        for (let suffix = 2; sizes.some(size => size.toLowerCase() === name.toLowerCase()); suffix++) name = `New size ${suffix}`;
        replace(addProductSize(document, name, Number(usualPrice)));
      }}>Add size</button>
    </div>
    <details className="mm-products__optional"><summary>More product information <small>Optional</small></summary>
      {([
        ["tagline", "Collection tagline"], ["productDetails", "Product details"], ["fabricMaterials", "Fabric & materials"],
        ["benefits", "Benefits"], ["fabricWeight", "Fabric weight"], ["dimensions", "Dimensions"],
        ["careInstructions", "Care instructions"], ["deliveryReturns", "Delivery & returns information"],
      ] as const).map(([key, label]) => <Field key={key} label={label} path={key} errors={errors}><textarea {...fieldAttributes(key, errors)} rows={2} maxLength={key === "tagline" ? 300 : 10000} value={document[key] || ""} onChange={event => patch({ [key]: event.target.value })} /></Field>)}
    </details>
  </div>;
}

type ColourProps = { document: CatalogueDocument; demo: boolean; errors: CatalogueEditorErrors; changeColour: (id: string, change: (colour: Colour) => Colour) => void; addPhotos: (id: string | null) => void; addColour: () => void; removeColour: (id: string) => void };
function ColourFields({ document, demo, errors, changeColour, addPhotos, addColour, removeColour }: ColourProps) {
  return <div className="mm-products__section"><p className="mm-products__intro">Add each colour and its photos. Your sizes and usual price are already carried across.</p>
    {document.colours.map((colour, index) => <section className="mm-products__colour" key={colour.id}>
      <Field label={`Colour ${index + 1}`} path={`colours.${index}.name`} errors={errors}><input {...fieldAttributes(`colours.${index}.name`, errors)} value={colour.name} maxLength={120} placeholder="e.g. Black" onChange={event => changeColour(colour.id, value => ({ ...value, name: event.target.value }))} /></Field>
      {document.colours.length > 1 && <button type="button" className="mm-products__text-button" aria-label={`Remove colour ${colour.name || index + 1}`} onClick={() => removeColour(colour.id)}>Remove colour</button>}
      <div className="mm-products__photos">{colour.photos.map((photo, photoIndex) => <div key={`${photo.url}-${photoIndex}`}><img src={photo.url} alt={photo.alt || colour.name} /><button type="button" aria-label={`Remove photo ${photoIndex + 1} from ${colour.name || `colour ${index + 1}`}`} onClick={() => changeColour(colour.id, value => ({ ...value, photos: value.photos.filter((_, position) => position !== photoIndex) }))}>Remove</button></div>)}</div>
      {demo ? <button type="button" disabled={colour.photos.length >= 12} onClick={() => addPhotos(colour.id)}>{colour.photos.length ? "Add more photos" : "Upload photos"}</button> : <p>Photo uploads will be available once the website connection is complete.</p>}
      <details className="mm-products__optional"><summary>Different prices for this colour <small>Optional</small></summary>
        {colour.variants.map((entry, variantIndex) => {
          const path = `colours.${index}.variants.${variantIndex}.price`;
          return <Field key={entry.id} label={`${entry.size} price (R)`} path={path} errors={errors}><input {...fieldAttributes(path, errors)} type="number" min="0.01" max={100000} step="0.01" inputMode="decimal" value={entry.price || ""} onChange={event => changeColour(colour.id, value => ({ ...value, variants: value.variants.map(variant => variant.id === entry.id ? { ...variant, price: Number(event.target.value) } : variant) }))} /></Field>;
        })}
      </details>
    </section>)}
    {errors.colours && <p className="mm-products__field-error">{errors.colours}</p>}
    <button type="button" disabled={document.colours.length >= 30} onClick={addColour}>Add colour</button>
  </div>;
}

type StockProps = { document: CatalogueDocument; demo: boolean; errors: CatalogueEditorErrors; changeColour: ColourProps["changeColour"] };
function StockFields({ document, demo, errors, changeColour }: StockProps) {
  return <div className="mm-products__section"><p className="mm-products__intro">{demo ? "Sample quantities only. " : ""}Enter the quantity you have. Once confirmed, zero stock means sold out. Uncheck availability to pause a colour or size.</p>
    {document.colours.map((colour, index) => <section className="mm-products__stock" key={colour.id}><header><h3>{colour.name || `Colour ${index + 1}`}</h3><label className="mm-products__check"><input type="checkbox" checked={colour.available && (colour.variants.length > 1 || colour.variants[0].available)} onChange={event => changeColour(colour.id, value => ({ ...value, available: event.target.checked, variants: value.variants.length === 1 ? value.variants.map(entry => ({ ...entry, available: event.target.checked })) : value.variants }))} />{colour.name || `Colour ${index + 1}`} available for sale</label></header>
      {colour.variants.map((entry, variantIndex) => {
        const path = `colours.${index}.variants.${variantIndex}.stock`;
        return <div className="mm-products__stock-row" key={entry.id}><Field label={`${entry.size || "Size"} stock${entry.stockVerified === false ? " — not counted yet" : ""}`} path={path} errors={errors}><input {...fieldAttributes(path, errors)} type="number" min={0} max={100000} step={1} inputMode="numeric" value={entry.stock} onChange={event => changeColour(colour.id, value => ({ ...value, variants: value.variants.map(variant => variant.id === entry.id ? { ...variant, stock: Number(event.target.value), stockVerified: true } : variant) }))} /></Field>
          {colour.variants.length > 1 && <label className="mm-products__check"><input type="checkbox" checked={entry.available} onChange={event => changeColour(colour.id, value => ({ ...value, variants: value.variants.map(variant => variant.id === entry.id ? { ...variant, available: event.target.checked } : variant) }))} />{entry.size || "Size"} available</label>}</div>;
      })}
    </section>)}
  </div>;
}

function Preview({ document, demo, patch, addPhotos }: { document: CatalogueDocument; demo: boolean; patch: DetailsProps["patch"]; addPhotos: ColourProps["addPhotos"] }) {
  const photos = document.colours.flatMap(colour => colour.photos);
  return <div className="mm-products__preview"><p className="mm-products__intro">This is how your product cards could look. Preview buttons don’t place orders.</p><h3>{document.name}</h3><p>{document.description}</p>
    <div className="mm-products__cards">{document.colours.map(colour => <ColourCard key={colour.id} name={document.name} colour={colour} />)}</div>
    <section className="mm-products__homepage"><h3>Homepage collection</h3><label className="mm-products__check"><input type="checkbox" checked={document.showOnHomepage} onChange={event => patch({ showOnHomepage: event.target.checked })} />Show this product on the homepage</label>
      {document.showOnHomepage ? <>
        <article className="mm-products__collection"><Photo url={document.homepageImage.url} alt={document.homepageImage.alt || document.name} /><h3>{document.name}</h3>{document.tagline && <p>{document.tagline}</p>}<span className="mm-products__mock-button">View product</span></article>
        <details className="mm-products__optional"><summary>Choose a different collection photo</summary><div className="mm-products__photo-choices">{photos.map((photo, index) => <button key={`${photo.url}-${index}`} type="button" aria-label={`Use collection photo ${index + 1}`} aria-pressed={document.homepageImage.url === photo.url} onClick={() => patch({ homepageImage: photo })}><img src={photo.url} alt={photo.alt || `Photo ${index + 1}`} /></button>)}</div>{demo && <button type="button" onClick={() => addPhotos(null)}>Upload another photo</button>}</details>
      </> : <p>This product won’t appear in Our Collection.</p>}
    </section>
  </div>;
}
function Photo({ url, alt }: { url: string; alt: string }) { return url ? <img src={url} alt={alt} /> : <div className="mm-products__empty-photo">Photo not added yet</div>; }
function ColourCard({ name, colour }: { name: string; colour: Colour }) {
  const [selectedId, setSelectedId] = useState("");
  const selected = colour.variants.find(entry => entry.id === selectedId);
  const prices = colour.variants.map(entry => entry.price);
  const available = colour.available && (selected ? variantAvailable(selected) : colour.variants.some(variantAvailable));
  return <article><Photo url={colour.photos[0]?.url || ""} alt={colour.photos[0]?.alt || `${name} ${colour.name}`} /><h3>{name} — {colour.name}</h3><p>{!selected && new Set(prices).size > 1 ? "From " : ""}{money.format(selected?.price ?? Math.min(...prices))}</p>
    <label className="mm-products__field">Size<select value={selectedId} onChange={event => setSelectedId(event.target.value)}><option value="">Select size</option>{colour.variants.map(entry => <option key={entry.id} value={entry.id} disabled={!colour.available || !variantAvailable(entry)}>{entry.size}{!colour.available || !variantAvailable(entry) ? " — Out of stock" : ""}</option>)}</select></label>
    <span className="mm-products__mock-button">{available ? "Add to cart" : "Out of stock"}</span></article>;
}

const styles = `
.mm-products{font-family:Jost,Inter,Arial,sans-serif;color:#302a24;max-width:1000px;margin:0 auto;padding:32px;background:#f5f3f0;box-sizing:border-box}.mm-products *{box-sizing:border-box}.mm-products h1,.mm-products h2,.mm-products h3{font-family:Montserrat,Jost,Inter,Arial,sans-serif;letter-spacing:0;line-height:1.3;font-weight:500}.mm-products h1{font-size:30px;margin:4px 0 12px}.mm-products h2{font-size:22px;margin:0 0 8px}.mm-products h3{font-size:18px;margin:12px 0 8px}.mm-products p{line-height:1.5;margin:6px 0 16px}.mm-products button{font:inherit;padding:11px 17px;min-height:44px;border:1px solid #a69e95;background:transparent;color:inherit;cursor:pointer;transition:background .15s}.mm-products button:hover:not(:disabled){background:#e1e4dc}.mm-products button:disabled{opacity:.55;cursor:not-allowed}.mm-products .mm-products__primary{background:#758166;color:white;border-color:#758166}.mm-products .mm-products__primary:hover:not(:disabled){background:#5d684f}.mm-products :is(button,input,textarea,select,summary):focus-visible{outline:3px solid #758166;outline-offset:3px}.mm-products__header,.mm-products__footer,.mm-products__title{display:flex;align-items:center;justify-content:space-between;gap:16px}.mm-products__eyebrow{font-size:11px;letter-spacing:.12em;color:#746d65}.mm-products__notice{font-size:13px;color:#746d65;border-bottom:1px solid #d5cfc8;padding:0 0 18px}.mm-products__success,.mm-products__error{padding:14px 18px;background:#e9ede2;border-left:3px solid #758166;margin:16px 0;font-size:14px}.mm-products__error{background:#f4e6e1;border-color:#8b3e2f}.mm-products__list{display:grid;gap:1px;background:#d5cfc8;border:1px solid #d5cfc8}.mm-products__row{display:flex;align-items:center;gap:18px;background:#fffaf5;padding:20px}.mm-products__row>div{flex:1;min-width:0}.mm-products__row p{font-size:14px;margin:0 0 4px;color:#746d65}.mm-products__row img,.mm-products__placeholder{width:72px;height:72px;object-fit:cover;flex-shrink:0}.mm-products__placeholder{display:grid;place-items:center;background:#e9e5e0;font-size:28px}.mm-products__badge{font-size:12px;color:#746d65}.mm-products .mm-products__back{border:0;padding-left:0;margin-bottom:16px}.mm-products__steps{list-style:none;display:flex;gap:16px;padding:0;margin:8px 0 28px;border-bottom:1px solid #d5cfc8}.mm-products__steps li{flex:1;font-size:14px;color:#746d65;padding:0 0 14px;border-bottom:3px solid transparent}.mm-products__steps li[aria-current=step]{color:#302a24;border-color:#758166}.mm-products__steps li>span{display:inline-grid;place-items:center;width:25px;height:25px;background:#e4e7df;border-radius:50%;margin-right:8px}.mm-products__title{margin-bottom:20px}.mm-products__title>span{font-size:12px;color:#746d65}.mm-products__form{border:0;padding:0;margin:0;min-width:0}.mm-products__section{padding:24px;background:#fffaf5;min-width:0}.mm-products__field{display:flex;flex-direction:column;gap:7px;font-size:14px;margin:0 0 20px}.mm-products input:not([type=checkbox]),.mm-products textarea,.mm-products select{width:100%;border:1px solid #bbb3aa;background:#fffaf5;color:inherit;padding:12px;font:inherit;border-radius:4px;min-width:0}.mm-products input[aria-invalid=true],.mm-products textarea[aria-invalid=true]{border-color:#8b3e2f}.mm-products textarea{resize:vertical}.mm-products small{color:#746d65;line-height:1.5}.mm-products .mm-products__field-error{color:#8b3e2f}.mm-products__sizes>p,.mm-products__intro{font-size:14px;color:#746d65}.mm-products__size{display:flex;align-items:flex-start;gap:12px}.mm-products__size .mm-products__field{flex:1}.mm-products__size>button{margin-top:24px}.mm-products__check{display:flex;align-items:center;gap:10px;font-size:14px;line-height:1.4;min-height:44px}.mm-products input[type=checkbox]{width:18px;height:18px;accent-color:#758166;flex-shrink:0}.mm-products__optional{margin:18px 0 0;padding-top:18px;border-top:1px solid #d5cfc8}.mm-products summary{cursor:pointer;min-height:44px;padding:8px 0}.mm-products summary small{font-size:12px;margin-left:8px}.mm-products__optional[open]>summary{margin-bottom:14px}.mm-products__accordion{border:1px solid #d5cfc8;background:#fffaf5;margin:12px 0}.mm-products__accordion>summary{font-size:18px;padding:20px}.mm-products__accordion>summary small{display:block;margin:5px 0 0 20px;font-size:13px}.mm-products__colour{padding:20px;background:#f5f3f0;border:1px solid #d5cfc8;margin:0 0 20px}.mm-products__photos,.mm-products__photo-choices{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}.mm-products__photos>div{display:flex;flex-direction:column;gap:6px}.mm-products__photos img,.mm-products__photo-choices img{width:96px;height:96px;object-fit:cover}.mm-products__photos button{font-size:12px;padding:6px}.mm-products__photo-choices button{padding:3px;border:2px solid transparent}.mm-products__photo-choices button[aria-pressed=true]{border-color:#758166}.mm-products__stock{border-bottom:1px solid #d5cfc8;margin-bottom:20px;padding-bottom:12px}.mm-products__stock:last-child{border:0;margin:0}.mm-products__stock header{margin-bottom:14px}.mm-products__stock-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;align-items:center}.mm-products__footer{padding:20px 0;margin-top:16px;border-top:1px solid #d5cfc8}.mm-products__preview{padding:24px;background:#eeeae6}.mm-products__cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));max-width:760px;gap:32px;margin:24px auto 40px}.mm-products__cards article{padding:14px;border:1px solid #a69e95;min-width:0}.mm-products__cards img,.mm-products__empty-photo{width:100%;aspect-ratio:1;object-fit:cover}.mm-products__empty-photo{display:grid;place-items:center;background:#d8d4cf;color:#746d65;font-size:14px}.mm-products__mock-button{display:block;background:#758166;color:white;padding:13px;text-align:center;font-size:14px}.mm-products__collection{max-width:300px;margin-top:18px}.mm-products__collection img{width:100%;aspect-ratio:1;object-fit:cover}.mm-products__homepage{border-top:1px solid #cfc8c0;padding-top:20px}
.mm-products .mm-products__primary,.mm-products__mock-button{background:#536047;border-color:#536047}.mm-products .mm-products__primary:hover:not(:disabled){background:#424d39}.mm-products__row h2,.mm-products__row p{overflow-wrap:anywhere}
@media(max-width:760px){.mm-products{padding:20px}.mm-products__section,.mm-products__colour,.mm-products__preview{padding:16px}.mm-products__cards{gap:20px}.mm-products__steps{gap:10px}.mm-products__steps li>span{display:grid;margin:0 0 8px}.mm-products__title{align-items:flex-start}.mm-products__row{display:grid;grid-template-columns:72px minmax(0,1fr);align-items:start}.mm-products__row>button{grid-column:1/-1;justify-self:start;margin:0}.mm-products__row h2{margin-top:0}}
@media(max-width:480px){.mm-products__cards{grid-template-columns:1fr}.mm-products__stock-row{grid-template-columns:1fr;gap:0}.mm-products__stock-row>.mm-products__check{margin:-12px 0 18px}.mm-products__steps li{font-size:12px}.mm-products__header{flex-wrap:wrap}.mm-products__row{grid-template-columns:54px minmax(0,1fr);gap:12px}.mm-products__row img,.mm-products__placeholder{width:54px;height:54px}.mm-products__row h2{font-size:18px}.mm-products__footer{align-items:stretch}.mm-products__footer>button{max-width:70%}}
`;
