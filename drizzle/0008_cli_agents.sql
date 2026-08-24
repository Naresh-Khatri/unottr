ALTER TABLE `ai_connections` ADD `kind` text DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_connections` ADD `executable_path` text;
