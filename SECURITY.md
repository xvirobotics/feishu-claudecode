# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use [GitHub Security Advisories](https://github.com/xvirobotics/metabot/security/advisories/new) to report vulnerabilities privately.

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

| Stage | Timeline |
|-------|----------|
| Acknowledgment | Within 48 hours |
| Initial assessment | Within 1 week |
| Fix & disclosure | Coordinated with reporter |

## Scope

The following are in scope for security reports:

- **Credential exposure** — Bot tokens, API keys, or secrets leaked through logs, error messages, or responses
- **Command injection** — Ability to execute unintended commands through user input
- **Session isolation bypass** — Accessing another chat's session data or working directory
- **Unauthorized file access** — Reading or writing files outside the configured working directory
- **Memory server data leakage** — Accessing other users' stored memories

## Out of Scope

- Vulnerabilities in upstream platforms (Claude API, Feishu/Lark API)
- Vulnerabilities in third-party dependencies (report these to the dependency maintainer)
- Social engineering attacks
- Denial of service attacks against the bot

## Security Best Practices for Contributors

- Never commit credentials, tokens, or secrets — use `.env` files (already in `.gitignore`)
- Never log sensitive data (API keys, user messages with PII)
- Validate and sanitize all external input (Feishu events, API parameters)
- Use parameterized queries for any database operations
- Review the [OWASP Top 10](https://owasp.org/www-project-top-ten/) before submitting security-sensitive code

## Acknowledgments

We appreciate responsible disclosure. Contributors who report valid security issues will be acknowledged in the project (unless they prefer to remain anonymous).
