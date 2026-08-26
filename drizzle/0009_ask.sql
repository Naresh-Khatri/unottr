CREATE TABLE `ask_messages` (
	`id` integer PRIMARY KEY NOT NULL,
	`thread_id` integer NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`payload_json` text,
	`provider` text,
	`model` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `ask_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ask_messages_thread` ON `ask_messages` (`thread_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `ask_threads` (
	`id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`scope_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ask_threads_updated` ON `ask_threads` (`updated_at`);