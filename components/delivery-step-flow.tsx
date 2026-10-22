"use client";
import { useEffect, useRef, type ReactNode } from "react";

type DeliveryStep = 1 | 2 | 3 | 4;
interface DeliveryStepFlowProps {
  current: DeliveryStep;
  onReview: (step: 1 | 2) => void;
  children: [ReactNode, ReactNode, ReactNode, ReactNode];
  locked?: boolean;
}
const deliveryStepTitles = ["Delivery details", "Parcel", "Courier", "Waybill & tracking"];

export default function DeliveryStepFlow({ current, onReview, children, locked = false }: DeliveryStepFlowProps) {
  const active = useRef<HTMLDivElement>(null), previous = useRef(current);
  useEffect(() => {
    if (previous.current !== current) active.current?.focus({ preventScroll: true });
    previous.current = current;
  }, [current]);
  return <div className="mm-delivery__flow">
    <style dangerouslySetInnerHTML={{ __html: deliveryStepFlowCss }} />
    {!locked && (current === 2 || current === 3) ? <button type="button" className="mm-admin__text-button mm-delivery__back" aria-label={`Back to ${current === 2 ? "delivery details" : "parcel"}`} onClick={() => onReview(current === 2 ? 1 : 2)}>Back</button> : null}
    <div key={current} ref={active} tabIndex={-1} className="mm-delivery__active-step" data-delivery-step={current} role="region" aria-label={`Step ${current}: ${deliveryStepTitles[current - 1]}`}>
      {children[current - 1]}
    </div>
  </div>;
}

const deliveryStepFlowCss = `
.mm-delivery__flow{display:grid;gap:14px;min-width:0;overflow:clip}.mm-delivery__back{justify-self:start;min-height:44px}
.mm-delivery__active-step{min-width:0;outline:none;animation:mm-delivery-slide-in 180ms ease-out both}.mm-delivery__active-step:focus-visible{outline:2px solid var(--mm-sage,#7d896d);outline-offset:-2px}
.mm-delivery__active-step .mm-admin__delivery-editor{margin:0}.mm-delivery__active-step h4{margin:0 0 16px}.mm-delivery__step-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:18px}
.mm-delivery__flow .mm-delivery__check{display:flex;align-items:flex-start;gap:10px;min-height:44px;font-size:14px;line-height:1.5}.mm-delivery__flow .mm-delivery__check input{flex:none;width:20px;height:20px;margin:1px 0;padding:0}
@keyframes mm-delivery-slide-in{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
@media(prefers-reduced-motion:reduce){.mm-delivery__active-step{animation:none}}
@media(max-width:600px){.mm-delivery__step-actions>.mm-delivery__primary-action{width:100%}}
`;
