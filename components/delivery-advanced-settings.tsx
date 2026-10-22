import type { ReactNode } from "react";

interface DeliveryAdvancedSettingsProps { children: ReactNode; needsAttention?: boolean }

export default function DeliveryAdvancedSettings({ children, needsAttention = false }: DeliveryAdvancedSettingsProps) {
  return <details className="mm-admin__technical mm-delivery__advanced" open={needsAttention ? true : undefined}>
    <style dangerouslySetInnerHTML={{ __html: `.mm-delivery__advanced{margin-top:18px;padding-top:14px;border-top:1px solid var(--mm-border,#a69e95);min-width:0;overflow-wrap:anywhere}.mm-delivery__advanced>summary{min-height:44px;align-content:center;cursor:pointer}.mm-delivery__advanced>summary:focus-visible{outline:3px solid var(--mm-sage,#7d896d);outline-offset:3px}` }} />
    <summary>Advanced settings{needsAttention ? " · needs attention" : ""}</summary>
    {children}
  </details>;
}
