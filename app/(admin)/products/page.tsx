import { MoreHorizontal, Plus, Search } from "lucide-react";
import Image from "next/image";
import { currency, products } from "@/lib/store-data";

export const metadata = { title: "Products" };

export default function ProductsPage() {
  return (
    <>
      <header className="page-header page-header-top"><div><p className="eyebrow">Catalogue</p><h1>Products</h1><p className="page-intro">Manage what customers see in the Moving Modesty store.</p></div><button className="button button-primary" type="button"><Plus size={17} /> Add product</button></header>
      <section className="panel data-panel">
        <div className="toolbar"><label className="search-field"><Search size={16} /><span className="sr-only">Search products</span><input placeholder="Search products" /></label><select aria-label="Filter product status"><option>All products</option><option>Active</option><option>Draft</option></select></div>
        <div className="product-grid">{products.map((product) => {
          const totalStock = product.variants.reduce((sum, variant) => sum + variant.stock, 0);
          return <article className="product-card" key={product.id}>
            <div className="product-image-wrap"><Image src={product.image} alt={product.name} fill sizes="(max-width: 760px) 100vw, 33vw" className="product-image" /><span className={`catalogue-status catalogue-${product.status.toLowerCase()}`}>{product.status}</span><button aria-label={`More actions for ${product.name}`}><MoreHorizontal size={18} /></button></div>
            <div className="product-copy"><p>{product.category}</p><h2>{product.name}</h2><strong>{currency.format(product.price)}</strong><div><span>{product.variants.length} variants</span><span className={totalStock < 5 ? "stock-low" : ""}>{totalStock} in stock</span></div></div>
          </article>;
        })}</div>
      </section>
    </>
  );
}
