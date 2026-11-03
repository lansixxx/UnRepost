# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-03

### Added
- **Native GUI Launcher**: Double-click `UnRepost.app` bundle for macOS running Chrome in app window mode.
- **Secure OS Path Storage**: Relocated session and persistent state to OS application support folders (`~/Library/Application Support/UnRepost`, `%APPDATA%/UnRepost`, `~/.config/unrepost`).
- **Network Hardening**: Server strictly bound to `127.0.0.1` with loopback host and origin verification middleware to prevent CSRF attacks.
- **Strict Verification Engine**: Response evaluator distinguishing confirmed removals (`delete_video_status === 1`) from rate limits, silent drops, and CAPTCHAs.
- **Pre-Scan Mode**: Safe read-only preview mode to discover and count reposts without triggering any deletions.
- **Session Lifecycle Controls**: "Sign Out & Clear Session" feature allowing full local credential erasure upon user confirmation.
- **Audit Export with Privacy Confirmation**: Export audit records to CSV and JSON with explicit warnings regarding sensitive IDs.
- **Native Unit Test Suite**: Comprehensive tests covering response parsing, state tracking, path resolution, and loopback security using `node:test`.
