"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";

interface OrderCardsProps<T extends { id: string }> {
  orders: T[];
  selectedId: string;
  onSelect: (id: string) => void;
  renderSummary: (order: T, expanded: boolean) => ReactNode;
  renderDetails: (close: () => void) => ReactNode;
  empty?: ReactNode;
}

// Display state only: no transport, order updates or courier actions.
export default function OrderCards<T extends { id: string }>({ orders, selectedId, onSelect, renderSummary, renderDetails, empty }: OrderCardsProps<T>) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusId = useRef("");
  useEffect(() => {
    if (selectedId || !returnFocusId.current) return;
    const trigger = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(".mm-admin__order-card") || [])
      .find(button => button.id === returnFocusId.current);
    returnFocusId.current = "";
    trigger?.focus({ preventScroll: true });
    trigger?.scrollIntoView?.({ behavior: "auto", block: "nearest" });
  }, [selectedId]);

  function close(id: string) {
    returnFocusId.current = `${baseId}-order-${encodeURIComponent(id)}`;
    onSelect("");
  }
  return <div className="mm-admin__order-list mm-admin__disclosure-list" ref={listRef}>
    <style>{orderCardsCss}</style>
    {!orders.length ? empty : null}
    {/* eslint-disable-next-line react-hooks/refs -- Render callbacks only attach close to buttons; refs are read in the effect, never while rendering. */}
    {orders.map(order => {
      const expanded = selectedId === order.id;
      const triggerId = `${baseId}-order-${encodeURIComponent(order.id)}`;
      const panelId = `${triggerId}-details`;
      return <div className="mm-admin__order-disclosure" key={order.id}>
        <button className={`mm-admin__order-card${expanded ? " is-selected" : ""}`} type="button" id={triggerId}
          aria-expanded={expanded} aria-controls={panelId} onClick={() => expanded ? close(order.id) : onSelect(order.id)}>
          {renderSummary(order, expanded)}
        </button>
        <div id={panelId} role="region" aria-labelledby={triggerId} hidden={!expanded}>
          {expanded ? renderDetails(() => close(order.id)) : null}
        </div>
      </div>;
    })}
  </div>;
}

const orderCardsCss = `
.mm-admin__disclosure-list { display:grid; gap:14px; background:transparent; }
.mm-admin__order-disclosure { min-width:0; border:1px solid var(--mm-border); background:var(--mm-surface); }
.mm-admin__order-disclosure > [hidden] { display:none; }
.mm-admin__order-disclosure .mm-admin__detail { border:0; border-top:1px solid var(--mm-border); }
.mm-admin__order-disclosure .mm-admin__order-card { min-height:44px; user-select:none; }
.mm-admin__order-summary-footer { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 14px; width:100%; min-width:0; }
.mm-admin__order-summary-footer .mm-admin__order-meta { overflow-wrap:anywhere; }
.mm-admin__order-toggle-label { color:var(--mm-ink); font-size:13px; font-weight:600; text-decoration:underline; text-underline-offset:3px; white-space:nowrap; }
.mm-admin__order-disclosure .mm-admin__close-details { display:block; align-self:flex-start; }
.mm-admin__order-disclosure :is(.mm-admin__order-card,.mm-admin__close-details):focus-visible { outline:2px solid var(--mm-sage); outline-offset:3px; }
`;
