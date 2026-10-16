interface OrderSyncStatusProps {
  value: { status: string; message?: string; remoteOrderId?: string };
}

export default function OrderSyncStatus({ value }: OrderSyncStatusProps) {
  return <section aria-label="Bob Go order synchronisation" role="status" style={{ margin: "16px 0", padding: "14px 16px", border: "1px solid var(--mm-border, #a69e95)", borderRadius: 8, overflowWrap: "anywhere" }}>
    <strong>Bob Go order sync: {value.status}</strong>
    {value.message ? <p className="mm-admin__helper" style={{ margin: "8px 0 0" }}>{value.message}</p> : null}
    {value.remoteOrderId ? <p className="mm-admin__helper" style={{ margin: "8px 0 0" }}>Bob Go order reference: {value.remoteOrderId}</p> : null}
  </section>;
}
