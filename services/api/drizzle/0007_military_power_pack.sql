CREATE TABLE "auditor_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sealed_key" "bytea" NOT NULL,
	"public_key_x" text NOT NULL,
	"public_key_y" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_block_number" bigint NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_block_number" bigint,
	"rotation_tx_hash" text
);
--> statement-breakpoint
CREATE INDEX "auditor_keys_active_idx" ON "auditor_keys" USING btree ("active");--> statement-breakpoint
CREATE INDEX "auditor_keys_block_range_idx" ON "auditor_keys" USING btree ("activated_block_number","retired_block_number");