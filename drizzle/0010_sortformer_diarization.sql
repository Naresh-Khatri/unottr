ALTER TABLE `recordings` ADD `diarization_engine` text;--> statement-breakpoint
ALTER TABLE `recordings` ADD `speaker_limit_hit` integer DEFAULT 0 NOT NULL;