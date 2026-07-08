CREATE TYPE "public"."treasury_deposit_source" AS ENUM('direct', 'cctp');--> statement-breakpoint
CREATE TYPE "public"."treasury_deposit_status" AS ENUM('submitted', 'confirmed', 'failed');--> statement-breakpoint
CREATE TABLE "treasury_deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"token" text NOT NULL,
	"token_id" bigint NOT NULL,
	"amount" text NOT NULL,
	"tx_hash" text,
	"source" "treasury_deposit_source" NOT NULL,
	"status" "treasury_deposit_status" NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "treasury_deposits" ADD CONSTRAINT "treasury_deposits_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "treasury_deposits_org_id_idx" ON "treasury_deposits" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "treasury_deposits_tx_hash_idx" ON "treasury_deposits" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "treasury_deposits_source_status_idx" ON "treasury_deposits" USING btree ("source","status");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_deposits_org_idempotency_key_uidx" ON "treasury_deposits" USING btree ("org_id","idempotency_key");