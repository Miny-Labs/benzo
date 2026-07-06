CREATE TYPE "public"."invite_kind" AS ENUM('invite', 'gift');--> statement-breakpoint
CREATE TYPE "public"."invite_status" AS ENUM('created', 'claimed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE "contacts" (
	"alias" text,
	"contact_address" text NOT NULL,
	"favorite" boolean DEFAULT false NOT NULL,
	"owner_user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handles" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handle" text NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"claimed_by" uuid,
	"creator_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"gift_amount" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "invite_kind" NOT NULL,
	"note" text,
	"status" "invite_status" DEFAULT 'created' NOT NULL,
	"token_hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handles" ADD CONSTRAINT "handles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_creator_user_id_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_owner_contact_idx" ON "contacts" USING btree ("owner_user_id","contact_address");--> statement-breakpoint
CREATE INDEX "contacts_owner_user_id_idx" ON "contacts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "handles_handle_idx" ON "handles" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "handles_user_id_idx" ON "handles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_hash_idx" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invites_creator_user_id_idx" ON "invites" USING btree ("creator_user_id");--> statement-breakpoint
CREATE INDEX "invites_claimed_by_idx" ON "invites" USING btree ("claimed_by");--> statement-breakpoint
CREATE INDEX "invites_status_expires_at_idx" ON "invites" USING btree ("status","expires_at");