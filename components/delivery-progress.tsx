interface DeliveryProgressProps { current: 1 | 2 | 3 | 4; paused?: boolean }

export default function DeliveryProgress({ current, paused = false }: DeliveryProgressProps) {
  return <div className="mm-delivery__progress">
    <style dangerouslySetInnerHTML={{ __html: deliveryProgressCss }} />
    <ol aria-label="Delivery steps">{["Check details", "Box & weight", "Choose & book", "Print & track"].map((label, index) => <li key={label}
      aria-current={current === index + 1 ? "step" : undefined} aria-label={current === index + 1 ? `Step ${current} of 4: ${label}` : undefined} data-complete={!paused && index + 1 < current ? "true" : undefined}>
      <span className="mm-delivery__step-number" aria-hidden="true">{index + 1}</span><span>{label}</span>
    </li>)}</ol>
  </div>;
}

const deliveryProgressCss = `
.mm-delivery__progress{margin:16px 0;min-width:0}.mm-delivery__progress ol{display:grid;grid-template-columns:1fr;gap:8px;list-style:none;padding:0;margin:0}
.mm-delivery__progress li:not([aria-current=step]){display:none}.mm-delivery__progress li[aria-current=step] .mm-delivery__step-number::after{content:" / 4"}
.mm-delivery__progress li{display:flex;align-items:center;gap:7px;padding:10px 8px;border:1px solid var(--mm-border,#a69e95);font-size:12px;line-height:1.4;min-width:0;overflow-wrap:normal}
.mm-delivery__progress li[aria-current=step]{border-color:var(--mm-sage,#7d896d);background:var(--mm-soft,#e3e6de);font-weight:700;box-shadow:inset 0 -2px var(--mm-sage,#7d896d)}
.mm-delivery__step-number{flex:none;font-weight:700}.mm-delivery__progress li[data-complete=true] .mm-delivery__step-number{color:var(--mm-ink,#302a24)}
.mm-admin .mm-delivery__primary-action{min-height:48px;max-width:100%;white-space:normal;text-align:center;justify-self:start}
.mm-admin .mm-delivery__primary-action:disabled{opacity:1;background:var(--mm-soft,#e3e6de);border:1px solid var(--mm-border,#a69e95);color:var(--mm-muted,#62594f)!important;cursor:not-allowed}
@media(max-width:600px){.mm-admin .mm-delivery__primary-action{width:100%}}
`;
