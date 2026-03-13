---
name: metamemory
description: MetaBot knowledge persistence system. Use to save, retrieve, and search documents in MetaMemory. Triggers when the user says "remember this", "save this to memory", "recall X", "what do you know about X", "write this to MetaMemory", "note this down", or any request to persist or retrieve knowledge across sessions.
---

# MetaMemory

MetaMemory is MetaBot's knowledge base — a persistent document store accessible via HTTP API. The credentials are already available as environment variables.

## API

Base URL: `$META_MEMORY_URL` (default: `http://localhost:8100`)
Auth header (if `$MEMORY_SECRET` is non-empty): `Authorization: Bearer $MEMORY_SECRET`

### Write / update a document
```bash
curl -s -X PUT "$META_MEMORY_URL/documents/path/to/doc.md" \
  -H "Authorization: Bearer $MEMORY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"content": "# Title\n\nContent here.", "title": "My Document"}'
```

### Read a document
```bash
curl -s "$META_MEMORY_URL/documents/path/to/doc.md" \
  -H "Authorization: Bearer $MEMORY_SECRET"
```

### Search documents
```bash
curl -s "$META_MEMORY_URL/search?q=your+query" \
  -H "Authorization: Bearer $MEMORY_SECRET"
```

### List folder tree
```bash
curl -s "$META_MEMORY_URL/folders" \
  -H "Authorization: Bearer $MEMORY_SECRET"
```

### Delete a document
```bash
curl -s -X DELETE "$META_MEMORY_URL/documents/path/to/doc.md" \
  -H "Authorization: Bearer $MEMORY_SECRET"
```

## Path Conventions

Organize documents in meaningful folder paths:
- `projects/<name>/architecture.md` — project notes
- `meetings/YYYY-MM/topic.md` — meeting notes
- `knowledge/<domain>/topic.md` — general knowledge
- `people/<name>.md` — notes about a person or team

When the user says "remember this" without specifying a path, choose a logical path based on the content type and topic.

## When to Use

- User says "remember", "note", "save", "record" → write a document
- User says "recall", "what do you know about", "look up in memory" → search or read
- User says "forget", "delete from memory" → delete a document
- After completing a task the user might want to remember → proactively offer to save
