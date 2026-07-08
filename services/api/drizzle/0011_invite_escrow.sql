CREATE TYPE "public"."invite_escrow_kind" AS ENUM('public', 'private');--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "escrow_gift_id" text;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "escrow_kind" "invite_escrow_kind";