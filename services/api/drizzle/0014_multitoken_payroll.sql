CREATE TYPE "public"."payroll_token" AS ENUM('usdc', 'eurc');--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "token" "payroll_token" DEFAULT 'usdc' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "token_id" bigint DEFAULT 1 NOT NULL;
