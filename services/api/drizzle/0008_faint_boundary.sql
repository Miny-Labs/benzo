ALTER TABLE "auditor_keys" ADD COLUMN "activated_log_index" integer;--> statement-breakpoint
ALTER TABLE "auditor_keys" ADD COLUMN "activated_transaction_index" integer;--> statement-breakpoint
ALTER TABLE "auditor_keys" ADD COLUMN "retired_log_index" integer;--> statement-breakpoint
ALTER TABLE "auditor_keys" ADD COLUMN "retired_transaction_index" integer;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "transaction_index" integer;
