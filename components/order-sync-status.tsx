interface OrderSyncStatusProps {
  value: { status: string; message?: string; remoteOrderId?: string };
}

export default function OrderSyncStatus({ value }: OrderSyncStatusProps) {
  return <details aria-label="Bob Go order synchronisation" open={value.status === "Needs attention" ? true : undefined} style={{ margin: "16px 0", padding: "10px 0", overflowWrap: "anywhere", fontSize: 13 }}>
    <summary style={{ minHeight: 44, cursor: "pointer", alignContent: "center" }}>Sales-channel sync: <strong>{value.status}</strong></summary>
    {value.message ? <p className="mm-admin__helper" style={{ margin: "8px 0 0" }}>{value.message}</p> : null}
    {value.remoteOrderId ? <p className="mm-admin__helper" style={{ margin: "8px 0 0" }}>Bob Go order reference: {value.remoteOrderId}</p> : null}
  </details>;
}
