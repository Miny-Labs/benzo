ALTER TABLE "onramp_intents" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "onramp_intents" ADD CONSTRAINT "onramp_intents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Plain CREATE INDEX (not CONCURRENTLY): the drizzle node-postgres migrator runs
-- all pending migrations inside one transaction, and CREATE INDEX CONCURRENTLY
-- cannot run in a transaction block. The brief lock is acceptable here — the index
-- is built together with the org_id column it covers, on onramp_intents, whose
-- Fuji production size is bounded.
CREATE INDEX "onramp_intents_org_id_idx" ON "onramp_intents" USING btree ("org_id");
