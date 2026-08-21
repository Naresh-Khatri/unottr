-- Phase 10. One AI connection per provider the user has added; the old single-Mistral
-- settings keys are lifted into a row here and then deleted, so nothing reads them again.
CREATE TABLE `ai_connections` (
	`id` integer PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`preset` text NOT NULL,
	`wire` text NOT NULL,
	`base_url` text NOT NULL,
	`key_enc` text,
	`key_plain` text,
	`active_model` text,
	`models_json` text,
	`models_fetched_at` integer,
	`strategy` text DEFAULT 'native' NOT NULL,
	`context_tokens` integer,
	`timeout_ms` integer,
	`price_in_usd` real,
	`price_out_usd` real,
	`consented` integer DEFAULT 0 NOT NULL,
	`spend_cents` real DEFAULT 0 NOT NULL,
	`probe_json` text,
	`probed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
-- which provider wrote it; `model` alone can't tell "gpt-4o via OpenAI" from a proxy
ALTER TABLE `overviews` ADD `provider` text;--> statement-breakpoint
INSERT INTO `ai_connections` (
	`label`, `preset`, `wire`, `base_url`, `key_enc`, `key_plain`, `active_model`,
	`strategy`, `price_in_usd`, `price_out_usd`, `consented`, `spend_cents`,
	`created_at`, `updated_at`
)
SELECT
	'Mistral', 'mistral', 'mistral', 'https://api.mistral.ai/v1',
	(SELECT `value` FROM `settings` WHERE `key` = 'mistral_api_key_enc'),
	(SELECT `value` FROM `settings` WHERE `key` = 'mistral_api_key_plain'),
	COALESCE((SELECT `value` FROM `settings` WHERE `key` = 'ai_model'), 'mistral-large-2512'),
	'native', 0.5, 1.5,
	CASE WHEN (SELECT `value` FROM `settings` WHERE `key` = 'ai_consented') = '1' THEN 1 ELSE 0 END,
	CAST(COALESCE((SELECT `value` FROM `settings` WHERE `key` = 'ai_spend_cents'), '0') AS REAL),
	CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)
WHERE EXISTS (
	SELECT 1 FROM `settings`
	WHERE `key` IN ('mistral_api_key_enc', 'mistral_api_key_plain') AND `value` <> ''
);--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`)
SELECT 'ai_active_connection_id', CAST(`id` AS TEXT) FROM `ai_connections` ORDER BY `id` LIMIT 1
ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`;--> statement-breakpoint
DELETE FROM `settings` WHERE `key` IN (
	'ai_model', 'ai_consented', 'ai_spend_cents', 'mistral_api_key_enc', 'mistral_api_key_plain'
);
