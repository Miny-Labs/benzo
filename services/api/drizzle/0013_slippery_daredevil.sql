CREATE TYPE "public"."org_member_allowlist_status" AS ENUM('enabled', 'revoked');--> statement-breakpoint
CREATE TABLE "org_member_allowlist" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "org_member_allowlist_status" NOT NULL,
	"tx_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_member_allowlist" ADD CONSTRAINT "org_member_allowlist_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_allowlist" ADD CONSTRAINT "org_member_allowlist_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_member_allowlist_org_user_uidx" ON "org_member_allowlist" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "org_member_allowlist_user_id_idx" ON "org_member_allowlist" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "org_member_allowlist_status_idx" ON "org_member_allowlist" USING btree ("status");