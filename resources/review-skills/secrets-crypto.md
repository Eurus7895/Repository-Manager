---
id: secrets-crypto
name: Secrets and cryptography
category: security
appliesTo: ["**/*"]
references: Microsoft SDL (credential scanning, approved cryptography); OWASP ASVS 5.0 cryptography and secret management; CWE-798, CWE-312, CWE-327, CWE-328, CWE-330, CWE-532, CWE-295
---
Secrets:
- Hard-coded passwords, API keys, tokens, private keys or connection strings in code, configuration, tests or docs (CWE-798). A placeholder such as <TOKEN> or an obviously fake value is not a finding.
- Secrets placed in URLs, query strings, command lines, logs, error messages or exception text (CWE-532), or written to disk unencrypted (CWE-312).
- Credentials embedded in a package index or registry URL (https://user:token@host), which tools often log.

Cryptography:
- Broken or weak algorithms for security purposes: MD5 or SHA-1 for signatures or passwords, DES, RC4, ECB mode (CWE-327, CWE-328).
- Randomness for tokens, ids or keys from a non-cryptographic generator (Math.random, random module, rand()) (CWE-330).
- TLS verification turned off: verify=False, rejectUnauthorized: false, InsecureSkipVerify, custom trust-all managers (CWE-295).
- Keys or IVs that are constant, reused or derived from a password without a KDF.

Name the exact file and line. Do not report a secret you cannot see; report a variable that will hold one only when it is logged or exposed.
