import { ArrowDownToLine, ArrowUpFromLine, Search, SlidersHorizontal } from "lucide-react";
import { products } from "@/lib/store-data";

export const metadata = { title: "Inventory" };

export default function InventoryPage() {
  const variants = products.flatMap((product) => product.variants.map((variant) => ({ ...variant, product: product.name })));
  return (
    <>
      <header className="page-header page-header-top"><div><p className="eyebrow">Stock control</p><h1>Inventory</h1><p className="page-intro">See what is available and record every stock adjustment.</p></div><button className="button button-primary" type="button"><SlidersHorizontal size={16} /> Adjust stock</button></header>
      <section className="inventory-alert"><div><span>4</span><p><strong>Low-stock variants</strong><small>Restock soon to avoid missed sales.</small></p></div><button className="text-link" type="button">View low stock only →</button></section>
      <section className="panel data-panel">
        <div className="toolbar"><label className="search-field"><Search size={16} /><span className="sr-only">Search inventory</span><input placeholder="Search product, SKU or colour" /></label><select aria-label="Filter inventory"><option>All stock levels</option><option>Low stock</option><option>Out of stock</option></select></div>
        <div className="table-wrap"><table><thead><tr><th>Product</th><th>Variant</th><th>SKU</th><th>Available</th><th>Stock level</th><th>Last movement</th></tr></thead><tbody>{variants.map((variant) => {
          const level = variant.stock === 0 ? "Out of stock" : variant.stock <= 2 ? "Low" : "Healthy";
          return <tr key={variant.sku}><td><strong>{variant.product}</strong></td><td>{variant.colour} · {variant.size}</td><td className="sku">{variant.sku}</td><td><strong className="stock-number">{variant.stock}</strong></td><td><span className={`stock-level stock-${level.toLowerCase().replaceAll(" ", "-")}`}>{level}</span></td><td className="muted-cell"><span className={variant.stock <= 2 ? "movement movement-out" : "movement movement-in"}>{variant.stock <= 2 ? <ArrowUpFromLine size={13} /> : <ArrowDownToLine size={13} />}{variant.stock <= 2 ? "Order allocated" : "Stock received"}</span></td></tr>;
        })}</tbody></table></div>
      </section>
    </>
  );
}
