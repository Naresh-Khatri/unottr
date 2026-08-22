-- Phase 11 item 2 (#50). A merge, a reassign or a re-diarize changes who said what without
-- touching a word of the transcript, so staleness cannot be inferred from the text: the
-- recording counts its speaker edits and every overview records the count it was written
-- against. Both default to 0, so nothing already in the library reads as stale.
ALTER TABLE `recordings` ADD `speakers_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `overviews` ADD `speakers_version` integer DEFAULT 0 NOT NULL;
