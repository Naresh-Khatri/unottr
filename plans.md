## Product roadmap (recorded 2026-08-23)

These come after the Phase 11 foundations unless noted. They are ordered by value and by what
the current data model can support without adding accounts or a cloud service.

1. [x] **Terminology memory.** Global literal correction rules for names,
   acronyms and phrases; whole-word and case-sensitive options; automatic use on new
   transcripts; reversible application to the existing library; JSON import/export. Keep the
   original Whisper text so deleting a rule can restore it. Project-specific rules wait for
   Projects instead of creating a second project model here.
2. [ ] **Project memory.** After Projects and Tasks, add a project page that answers "what changed
   since last time?", shows open loops and reversed decisions, and accepts scoped questions.
   Every answer must cite recording segments through the existing grounding path.
3. [ ] **Evidence clips.** Select transcript text, a decision or an overview bullet and export
   the matching audio/video range with optional captions and a small context note. Local files
   only; no hosted sharing service.
4. [ ] **Automatic destinations.** After a transcript or overview finishes, write a chosen
   Markdown/JSON template to a folder or Obsidian vault, with an optional webhook. Never enable
   network delivery implicitly.
