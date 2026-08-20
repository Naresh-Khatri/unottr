CREATE TABLE `recordings` (
	`id` integer PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`fp_size` integer NOT NULL,
	`fp_head` blob NOT NULL,
	`fp_tail` blob NOT NULL,
	`container` text,
	`duration_ms` integer,
	`recorded_at` integer,
	`status` text NOT NULL,
	`stage_detail` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_chunk_idx` integer,
	`available` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`force_cpu` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recordings_path_unique` ON `recordings` (`path`);--> statement-breakpoint
CREATE INDEX `idx_recordings_status` ON `recordings` (`status`);--> statement-breakpoint
CREATE INDEX `idx_recordings_fp` ON `recordings` (`fp_size`,`fp_head`);--> statement-breakpoint
CREATE TABLE `segments` (
	`id` integer PRIMARY KEY NOT NULL,
	`recording_id` integer NOT NULL,
	`chunk_idx` integer NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`text` text NOT NULL,
	`words` text,
	`speaker_id` integer,
	`split_of` integer,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`speaker_id`) REFERENCES `speakers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_segments_recording` ON `segments` (`recording_id`,`start_ms`);--> statement-breakpoint
CREATE INDEX `idx_segments_chunk` ON `segments` (`recording_id`,`chunk_idx`);--> statement-breakpoint
CREATE INDEX `idx_segments_split` ON `segments` (`recording_id`,`split_of`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `speakers` (
	`id` integer PRIMARY KEY NOT NULL,
	`recording_id` integer NOT NULL,
	`label` text NOT NULL,
	`display_name` text,
	`embedding` blob,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `speakers_recording_id_label_unique` ON `speakers` (`recording_id`,`label`);--> statement-breakpoint
CREATE TABLE `watch_folders` (
	`id` integer PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`track_rule` text DEFAULT 'auto' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watch_folders_path_unique` ON `watch_folders` (`path`);