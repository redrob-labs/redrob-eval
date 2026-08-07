# Security

## Reporting vulnerabilities

Please report security issues privately to the repository maintainer (Janghoon Lee / 이장훈) via the contact method listed on the GitHub profile or by opening a **private** security advisory if this repository is hosted on GitHub.

Do not file public issues that include secrets, API keys, or exploit details.

## Scope

This project is a **local-first** eval / optimization harness:

- Provider API keys are read from server-side `.env` only.
- There is no built-in auth, multi-tenant hosting, or billing.
- Treat any deployment that exposes the Next.js server to a network as your own responsibility (bind carefully; do not put raw keys in client bundles).

## GPU deploy surface

`/deploy` opens an SSH session to a host you own and runs shell steps on it. Treat it as a remote root console:

- `GPU_SSH_KEY` is a **path**; the key is read server-side and never sent to the browser. Anyone who can reach the Next.js server can drive that SSH session.
- The terminal, inject and tunnel endpoints have no auth of their own. Do not expose port `3939` beyond loopback.
- vLLM binds `127.0.0.1` on the GPU host and always requires `--api-key`; reach it through the tunnel, not an open port.
- Steps persist in a `tmux` session on the host, so they outlive the browser tab. Use **End session** to kill them.

## Keys

- Never commit `.env` or real credentials.
- If a key may have leaked, **revoke and rotate** it at the provider immediately.
- `.env.example` must contain placeholders only.
