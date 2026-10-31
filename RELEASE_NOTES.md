Jot Import 1.0.3 fixes imports into notes that list a property twice.

- When two devices link the same Obsidian note before syncing, Obsidian Sync can list `jot-category-id` twice in it. Obsidian then can't read any of the note's properties, and an import stopped at that note. Jot Import now reads these notes, and lists the property once when it writes to them.
- When an import stops, the message is clearer and puts each step on its own line.
- **New note** and **New heading** in the menus are in your accent color, so they don't look like notes that already exist.
