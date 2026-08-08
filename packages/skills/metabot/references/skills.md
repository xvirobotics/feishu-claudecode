# Skill Hub

```bash
metabot skills list
metabot skills search "query"
metabot skills get <name>
metabot skills install <name> [--to <dir>] [--trust]
metabot skills publish <name> --from <bundle-dir>
metabot skills remove <name>
```

A Skill bundle contains `SKILL.md` and may contain `references/`, `scripts/`,
and `assets/`. Install the complete bundle. Project and global destinations are
different discovery scopes.

`metabot skills install` defaults to `.metabot/skills/<name>` so you can review
downloaded instructions before an engine auto-loads them. Passing `--to` with an
engine discovery directory such as `.claude/skills/<name>`,
`.codex/skills/<name>`, or `.agents/skills/<name>` requires `--trust`.
Publishing requires an admin credential or a member credential with
`publishSkill=true`; only admins may publish broadly visible skills.
