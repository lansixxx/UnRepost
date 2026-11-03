# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take the security of this project and user privacy seriously. UnRepost is designed to operate strictly on the local machine (`127.0.0.1`) without any remote analytics, backend servers, or data collection.

If you believe you have discovered a security vulnerability (such as a local privilege escalation, network exposure vulnerability, or sensitive credential leakage), please **do not open a public issue**.

Instead, please report security issues through:
1. **GitHub Security Advisory**: Open a private vulnerability report via the **Security** tab of the GitHub repository.
2. If private advisories are unavailable, create an issue marked strictly as a security inquiry without including sensitive payloads or reproduction steps that expose live credentials.

### What to Include in Your Report
- A clear description of the vulnerability.
- Steps to reproduce the issue locally.
- Proof of concept (PoC) code or configuration (sanitized to remove any real accounts or tokens).
- Impact assessment (e.g., local origin bypass, process isolation issue).

### User Security Best Practices
- **Never commit or share your session files**: The directory `tiktok_session_data/` and state file `unrepost_state.json` contain local authentication tokens. Never attach them to issues, emails, or chat channels.
- **Localhost only**: UnRepost binds exclusively to `127.0.0.1` and blocks external origin/host headers. Do not expose port 3210 to public networks or local area networks.
