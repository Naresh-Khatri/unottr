CREATE TABLE `person_voice_samples` (
	`id` integer PRIMARY KEY NOT NULL,
	`person_id` integer NOT NULL,
	`recording_id` integer NOT NULL,
	`speaker_id` integer,
	`speaker_label` text NOT NULL,
	`captured_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`speaker_id`) REFERENCES `speakers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_person_voice_samples_person` ON `person_voice_samples` (`person_id`,`captured_at`);--> statement-breakpoint
CREATE INDEX `idx_person_voice_samples_recording` ON `person_voice_samples` (`recording_id`);