CREATE TABLE "chain_cursor" (
	"contract" text PRIMARY KEY NOT NULL,
	"last_block" bigint NOT NULL,
	"last_block_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_links" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tx_hash" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"contract" text NOT NULL,
	"event_name" text NOT NULL,
	"from_addr" text,
	"to_addr" text,
	"ciphertext" "bytea"[] DEFAULT ARRAY[]::bytea[] NOT NULL,
	"amount_pct" "bytea",
	"raw_log" jsonb NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "event_links_tx_hash_idx" ON "event_links" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "event_links_object_uidx" ON "event_links" USING btree ("object_type","object_id","tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "events_tx_hash_log_index_uidx" ON "events" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "events_from_addr_idx" ON "events" USING btree ("from_addr");--> statement-breakpoint
CREATE INDEX "events_to_addr_idx" ON "events" USING btree ("to_addr");--> statement-breakpoint
CREATE INDEX "events_block_number_idx" ON "events" USING btree ("block_number");--> statement-breakpoint
CREATE INDEX "events_contract_block_number_idx" ON "events" USING btree ("contract","block_number");