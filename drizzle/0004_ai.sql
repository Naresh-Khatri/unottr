-- Phase 09. Hand-written: drizzle-kit cannot generate the fts5 table, and `push` would
-- propose dropping it (same reason as 0001_fts).
CREATE TABLE `overviews` (
	`id` integer PRIMARY KEY NOT NULL,
	`recording_id` integer NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
	`status` text NOT NULL,
	`error` text,
	`error_kind` text,
	`model` text,
	`prompt_version` integer DEFAULT 0 NOT NULL,
	`role_used` text,
	`title` text,
	`tldr` text,
	`sections` text,
	`decisions` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `overviews_recording_id_unique` ON `overviews` (`recording_id`);--> statement-breakpoint
-- owner is a speaker, not a person: a `people` row only exists once someone has been named,
-- so a people-keyed owner would be NULL on nearly every task in a fresh library. "Mine" is
-- the join through speakers.person_id.
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY NOT NULL,
	`recording_id` integer NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
	`text` text NOT NULL,
	`owner_speaker_id` integer REFERENCES speakers(id) ON DELETE SET NULL,
	`start_ms` integer NOT NULL,
	`due_raw` text,
	`due_date` text,
	`status` text DEFAULT 'open' NOT NULL,
	`user_edited` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_tasks_recording` ON `tasks` (`recording_id`);--> statement-breakpoint
ALTER TABLE `recordings` ADD `title` text;--> statement-breakpoint
ALTER TABLE `recordings` ADD `ai_title` text;--> statement-breakpoint
ALTER TABLE `people` ADD `is_me` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `role` text;--> statement-breakpoint
-- standalone, not content='' — the one function that writes an overview maintains it.
-- segments_fts' triggers are bound to `segments`; keep the two independent.
CREATE VIRTUAL TABLE overview_fts USING fts5(
  title,
  body,
  recording_id UNINDEXED,
  tokenize='unicode61'
);
