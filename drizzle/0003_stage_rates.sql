CREATE TABLE `stage_rates` (
	`key` text PRIMARY KEY NOT NULL,
	`rate` real NOT NULL,
	`samples` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
