"use client";

import {
  BarChart3,
  Box,
  ChevronDown,
  CircleHelp,
  LogOut,
  Menu,
  PackageOpen,
  Settings,
  ShoppingBag,
  Sparkles,
  Truck,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/app/login/actions";

const navigation = [
  { label: "Overview", href: "/dashboard", icon: BarChart3 },
  { label: "Orders", href: "/orders", icon: ShoppingBag, badge: "3" },
  { label: "Products", href: "/products", icon: PackageOpen },
  { label: "Inventory", href: "/inventory", icon: Box },
  { label: "Delivery", href: "/delivery", icon: Truck },
];

function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="admin-nav" aria-label="Admin navigation">
      <p className="nav-eyebrow">Workspace</p>
      {navigation.map(({ label, href, icon: Icon, badge }) => (
        <Link className={pathname === href || (href !== "/dashboard" && pathname.startsWith(href)) ? "nav-link nav-link-active" : "nav-link"} href={href} key={href}>
          <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
          <span>{label}</span>
          {badge ? <span className="nav-badge">{badge}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin-shell">
      <aside className="sidebar">
        <Link className="brand" href="/dashboard" aria-label="Moving Modesty dashboard">
          <span className="brand-mark"><Sparkles size={17} strokeWidth={1.6} /></span>
          <span><strong>Moving Modesty</strong><small>Administration</small></span>
        </Link>
        <NavLinks />
        <div className="sidebar-footer">
          <Link className="nav-link" href="/settings"><Settings size={18} /> Settings</Link>
          <Link className="nav-link" href="/support"><CircleHelp size={18} /> Help & support</Link>
          <form action={logoutAction}>
          <button className="account-card" type="submit">
            <span className="avatar">CM</span>
            <span className="account-copy"><strong>Store owner</strong><small>Administrator</small></span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          </form>
        </div>
      </aside>

      <div className="mobile-bar">
        <Link className="mobile-brand" href="/dashboard">MM</Link>
        <span>Admin portal</span>
        <details className="mobile-menu">
          <summary aria-label="Open navigation"><Menu size={22} /></summary>
          <div className="mobile-menu-panel">
            <NavLinks />
            <Link className="nav-link" href="/settings"><Settings size={18} /> Settings</Link>
            <form action={logoutAction}><button className="nav-link nav-button" type="submit"><LogOut size={18} /> Sign out</button></form>
          </div>
        </details>
      </div>

      <main className="main-content">{children}</main>
    </div>
  );
}
