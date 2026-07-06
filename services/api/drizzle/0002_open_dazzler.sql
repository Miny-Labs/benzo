CREATE TYPE "public"."onboarding_status" AS ENUM('pending_kyc', 'kyc_approved', 'allowlisted', 'gas_dripped', 'awaiting_registration', 'complete', 'failed');--> statement-breakpoint
CREATE TABLE "drips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"address" text NOT NULL,
	"chain_env" text NOT NULL,
	"chain_id" integer NOT NULL,
	"amount_wei" text NOT NULL,
	"tx_hash" text NOT NULL,
	"mode" text NOT NULL,
	"dripped_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kyc_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text DEFAULT 'mock' NOT NULL,
	"payload" jsonb NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kyc_records_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "onboardings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "onboarding_status" DEFAULT 'pending_kyc' NOT NULL,
	"chain_env" text NOT NULL,
	"chain_id" integer NOT NULL,
	"kyc_approved_at" timestamp with time zone,
	"allowlist_tx_hash" text,
	"allowlist_result" text,
	"allowlisted_at" timestamp with time zone,
	"gas_drip_tx_hash" text,
	"gas_drip_result" text,
	"gas_dripped_at" timestamp with time zone,
	"registration_last_checked_at" timestamp with time zone,
	"registration_completed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboardings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "drips" ADD CONSTRAINT "drips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_records" ADD CONSTRAINT "kyc_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drips_address_idx" ON "drips" USING btree ("address");--> statement-breakpoint
CREATE INDEX "drips_address_dripped_at_idx" ON "drips" USING btree ("address","dripped_at");--> statement-breakpoint
CREATE INDEX "drips_user_id_idx" ON "drips" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "kyc_records_user_id_idx" ON "kyc_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "kyc_records_provider_idx" ON "kyc_records" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "onboardings_user_id_idx" ON "onboardings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "onboardings_status_idx" ON "onboardings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "onboardings_updated_at_idx" ON "onboardings" USING btree ("updated_at");