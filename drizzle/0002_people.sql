CREATE TABLE `people` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`embedding` blob,
	`samples` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_name_key_unique` ON `people` (`name_key`);--> statement-breakpoint
ALTER TABLE `speakers` ADD `person_id` integer REFERENCES people(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `idx_speakers_person` ON `speakers` (`person_id`);