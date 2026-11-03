# Contributing to UnRepost

Thank you for your interest in contributing! This project is dedicated to providing a transparent, completely free, privacy-focused tool for managing TikTok reposts.

## Guiding Principles

1. **Zero Telemetry**: We never collect, transmit, or analyze user data. All operations happen strictly on the user's local machine.
2. **Safety & Verification First**: Deletion actions must be verifiable. We never falsely report an action as successful without confirmation.
3. **Minimal External Dependencies**: Keep the codebase lean, auditable, and easy for any user to inspect.
4. **Honest Limitations**: Respect platform constraints, rate limits, and CAPTCHAs gracefully rather than attempting risky evasions.

## Development Setup

### Prerequisites
- Node.js 18 or higher
- Google Chrome or Chromium installed on your system
- Git

### Installation
1. Fork the repository on GitHub.
2. Clone your fork locally:
   ```bash
   git clone https://github.com/lansixxx/UnRepost.git
   cd unrepost
   ```
3. Install dependencies:
   ```bash
   npm install
   ```

### Running Tests
All tests are implemented using the native Node.js test runner (`node:test`) and require no external test framework:
```bash
npm test
```
Ensure all tests pass before submitting changes.

### Running Locally
To run UnRepost in developer mode:
```bash
npm start
```
Open `http://127.0.0.1:3210` in your browser.

### Building macOS App Bundle
To generate the local standalone macOS `.app` bundle:
```bash
npm run build:mac
```
The output will be placed in `dist/UnRepost.app`.

## Submitting a Pull Request

1. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Commit your changes with clear, descriptive commit messages.
3. Verify that `npm test` passes without errors.
4. Push your branch to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```
5. Open a Pull Request against the `main` branch. Provide a clear explanation of what changed and why.

## Code Standards
- Keep network interfaces bound strictly to `127.0.0.1`.
- Preserve comments, docstrings, and comprehensive error handling.
- Do not log session cookies, authorization headers, or personal identifiers.
