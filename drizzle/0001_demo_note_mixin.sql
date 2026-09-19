ALTER TABLE "demo_note" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "demo_note" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "demo_note" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "demo_note" ADD COLUMN "score" double precision;--> statement-breakpoint
ALTER TABLE "demo_note" ADD COLUMN "score_explanation" text;--> statement-breakpoint
ALTER TABLE "demo_note" ADD COLUMN "spec_version" integer;