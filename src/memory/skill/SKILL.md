---
name: metamemory
description: Read and write shared memory documents. Use this when you need to save knowledge, notes, research findings, or project context for future reference across sessions. Also use it to look up previously stored information.
---

## MetaMemory Document Server

A shared memory server stores documents as organized Markdown files in a folder tree.
Server URL: !`echo ${MEMORY_SERVER_URL:-http://localhost:8100}`

### When to Use
- User asks to "remember", "save", "note down" something
- You discover important project knowledge worth preserving
- You need context from previous sessions or other agents' work
- After completing research or analysis that should be shared

### Quick Commands (mm shortcut)

The `mm` CLI is pre-installed and handles auth automatically. **Always prefer `mm` over raw curl:**

```bash
# Read
mm search <query>              # Search documents
mm get <doc_id>                # Get document by ID
mm path </folder/doc-slug>     # Get document by path
mm list [folder_id]            # List documents (default: root)
mm folders                     # Browse folder tree

# Write
mm create <title> [opts] [content]   # Create document
    --folder <id>   Target folder (default: root)
    --tags <a,b>    Comma-separated tags
    --by <name>     Creator name
    # Content via stdin (recommended for multiline):
    echo '# My Doc' | mm create "Title" --folder FOLDER_ID --tags "dev" --by "bot-name"

mm update <doc_id> [opts] [content]  # Update document
    --title <t>     New title
    --tags <a,b>    New tags
    echo '# Updated' | mm update DOC_ID

mm mkdir <name> [parent_id]    # Create folder (default parent: root)
mm delete <doc_id>             # Delete document

# System
mm health                      # Health check
```

All write commands handle JSON escaping safely (multiline content, special characters).
For stdin content, pipe markdown: `cat notes.md | mm create "Notes" --folder ID`

### Guidelines
- Write documents as structured Markdown with clear headings
- Use descriptive titles and relevant tags
- Organize into folders by project or topic
- Before creating, search first to avoid duplicates (`mm search <query>`)
- Update existing docs rather than creating new ones when appropriate
- Include created_by to track which agent wrote the document
