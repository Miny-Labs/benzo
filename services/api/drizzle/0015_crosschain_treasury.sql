ALTER TABLE "onramp_intents" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "onramp_intents" ADD CONSTRAINT "onramp_intents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onramp_intents_org_id_idx" ON "onramp_intents" USING btree ("org_id");
