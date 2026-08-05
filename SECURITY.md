# Security

## Reporting vulnerabilities

Please report security issues privately to the repository maintainer (Janghoon Lee / 이장훈) via the contact method listed on the GitHub profile or by opening a **private** security advisory if this repository is hosted on GitHub.

Do not file public issues that include secrets, API keys, or exploit details.

## Scope

This project is a **local-first** eval / optimization harness:

- Provider API keys are read from server-side `.env` only.
- There is no built-in auth, multi-tenant hosting, or billing.
- Treat any deployment that exposes the Next.js server to a network as your own responsibility (bind carefully; do not put raw keys in client bundles).

## Keys

- Never commit `.env` or real credentials.
- If a key may have leaked, **revoke and rotate** it at the provider immediately.
- `.env.example` must contain placeholders only.
