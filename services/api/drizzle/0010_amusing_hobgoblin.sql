CREATE TYPE "public"."onramp_dest_token" AS ENUM('usdc', 'eurc');--> statement-breakpoint
CREATE TYPE "public"."onramp_status" AS ENUM('initiated', 'burned', 'attested', 'minted', 'credited', 'needs_onboarding', 'failed');--> statement-breakpoint
CREATE TABLE "onramp_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"user_address" text NOT NULL,
	"source_domain" integer NOT NULL,
	"source_chain_id" integer NOT NULL,
	"source_tx_hash" text NOT NULL,
	"dest_token" "onramp_dest_token" NOT NULL,
	"amount" text,
	"user_pub_key_x" text NOT NULL,
	"user_pub_key_y" text NOT NULL,
	"cctp_nonce" text,
	"message_hash" text,
	"status" "onramp_status" DEFAULT 'initiated' NOT NULL,
	"settle_tx_hash" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onramp_intents" ADD CONSTRAINT "onramp_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onramp_intents_source_tx_hash_uidx" ON "onramp_intents" USING btree ("source_tx_hash");--> statement-breakpoint
CREATE INDEX "onramp_intents_user_id_idx" ON "onramp_intents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "onramp_intents_user_address_idx" ON "onramp_intents" USING btree ("user_address");--> statement-breakpoint
CREATE INDEX "onramp_intents_status_idx" ON "onramp_intents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "onramp_intents_updated_at_idx" ON "onramp_intents" USING btree ("updated_at");