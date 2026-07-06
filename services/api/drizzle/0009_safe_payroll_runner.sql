ALTER TABLE "org_treasuries" ADD COLUMN "eerc_registered_at" timestamp with time zone;--> statement-breakpoint
UPDATE "org_treasuries" SET "eerc_registered_at" = now() WHERE "sealed_eerc_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "confirmation_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "submission_raw_tx" "bytea";