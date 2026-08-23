CREATE TABLE `terminology_rules` (
	`id` integer PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_key` text NOT NULL,
	`replacement` text NOT NULL,
	`case_sensitive` integer DEFAULT 0 NOT NULL,
	`whole_word` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `terminology_rules_source_key_whole_word_unique` ON `terminology_rules` (`source_key`,`whole_word`);--> statement-breakpoint
ALTER TABLE `overviews` ADD `transcript_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `recordings` ADD `transcript_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `segments` ADD `raw_text` text;
