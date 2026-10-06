---
id: secrets-crypto
name: Secrets and cryptography
category: security
appliesTo: ["**/*"]
references: Microsoft SDL (credential scanning, approved cryptography); OWASP ASVS 5.0 cryptography and secret management; CWE-798, CWE-312, CWE-532, CWE-598, CWE-327, CWE-328, CWE-916, CWE-338, CWE-295, CWE-329
---
Secrets:
- Hard-coded passwords, API keys, tokens, private keys or connection strings in code, configuration, tests or docs (CWE-798). A placeholder such as <TOKEN> or an obviously fake value is not a finding.
- Secrets written to logs or error messages (CWE-532), put in URLs or query strings (CWE-598), passed on command lines, or stored on disk unencrypted (CWE-312).
- Credentials embedded in a package index or registry URL (https://user:token@host), which tools often log.

Cryptography:
- Broken algorithms for security purposes: MD5 or SHA-1 for signatures or integrity against tampering, DES, 3DES, RC4, ECB mode (CWE-327, CWE-328).
- Passwords stored with any fast hash (MD5, SHA-1, SHA-256, unsalted or not) instead of bcrypt, scrypt, Argon2 or PBKDF2 (CWE-916).
- Tokens, ids, keys or nonces from a non-cryptographic generator: Math.random, Python random, rand(), java.util.Random (CWE-338).
- TLS verification turned off: verify=False, rejectUnauthorized: false, InsecureSkipVerify, trust-all managers or hostname verifiers (CWE-295).
- Keys or IVs that are constant or reused, or keys derived from a password without a KDF (CWE-329).

Name the exact file and line. Do not report a secret you cannot see; report a variable that will hold one only when it is logged or exposed.
