---
id: injection-sinks
name: Injection and dangerous sinks
category: security
appliesTo: ["**/*.py", "**/*.js", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.java", "**/*.kt", "**/*.cs", "**/*.go", "**/*.rb", "**/*.php", "**/*.rs", "**/*.swift", "**/*.scala", "**/*.c", "**/*.cc", "**/*.cpp", "**/*.cxx", "**/*.h", "**/*.hh", "**/*.hpp", "**/*.hxx", "**/*.sh", "**/*.ps1", "**/*.sql"]
references: CWE Top 25 (CWE-78, CWE-77, CWE-79, CWE-89, CWE-94, CWE-22, CWE-502, CWE-918, CWE-434, CWE-611); CWE-117, CWE-113; OWASP ASVS 5.0 encoding and sanitization
---
Trace data from where it enters (request parameters, headers, files, environment, CLI arguments, messages, database rows written by users) to where it is used. Report only a path you can cite end to end. The language skills name the APIs; this list is the kinds of sink.

- OS commands: a command line built as one string from input and run through a shell, instead of an argument array (CWE-78, CWE-77).
- Code evaluation: evaluating strings as code, loading a module or class named by input, template engines rendering templates that users supply (CWE-94).
- Queries built by concatenation or formatting instead of parameters: SQL (CWE-89), LDAP, XPath, NoSQL filters.
- HTML or script output without context-aware encoding, including raw or "safe" template output (CWE-79).
- File paths joined from input without normalizing and checking they stay under a base directory; archive entries extracted by their own names (zip slip) (CWE-22).
- Native deserialization of data that crosses a trust boundary (CWE-502).
- Outbound requests to a URL or host taken from input (SSRF), including redirects and cloud metadata addresses (CWE-918).
- XML parsed with external entities or DTDs enabled (CWE-611); uploads stored under their original name or trusted by their declared type (CWE-434).
- Line breaks from input written into logs (CWE-117) or response headers (CWE-113).

A sink is safe when the value is a constant, comes from an allow-list, is passed as a parameter or argument array, or is validated against the exact form the sink needs. Say which guard you checked when you reject a candidate.
