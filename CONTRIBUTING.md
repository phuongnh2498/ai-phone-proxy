# Contributing

Thanks for wanting to help! Issues and pull requests are welcome.

## Setup

Requirements: macOS and Node 20+.

```bash
git clone https://github.com/phuongnh2498/ai-phone-proxy.git
cd ai-phone-proxy
npm install        # also rebuilds better-sqlite3 for Electron
npm start          # run the Electron app
npm test
```

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Keep each PR focused on one change. Small PRs get reviewed faster.
3. Add or update tests when you change behaviour, and make sure `npm test` passes.
4. Say what you changed and how you tested it (a screenshot helps for UI changes).

Good first areas: Android setup flow, Windows/Linux support, more export formats, better app detection.

## Reporting bugs

Open an issue with your macOS version, phone model/OS, steps to reproduce, and what you expected.
**Don't paste captured traffic that contains tokens, cookies or personal data.**

## Security issues

Please don't open a public issue for vulnerabilities (for example, ways to reach the Mac through the proxy or to leak the CA key).
Use GitHub's private reporting instead: **Security → Report a vulnerability**.

## Responsible use

This tool is for debugging traffic from devices and apps you own or are authorized to test.
