ALTER TABLE shipments ADD COLUMN courier_charged_amount numeric(12, 2);
--> statement-breakpoint
CREATE TABLE bobgo_delivery_events (
  id text PRIMARY KEY,
  shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('production', 'sandbox')),
  topic text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX bobgo_delivery_events_due_idx ON bobgo_delivery_events(environment, status, next_attempt_at);
