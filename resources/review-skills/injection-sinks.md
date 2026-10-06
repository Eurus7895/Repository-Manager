---
id: injection-sinks
name: Injection and dangerous sinks
category: security
appliesTo: ["**/*.py", "**/*.js", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx", "**/*.jsx", "**/*.java", "**/*.kt", "**/*.cs", "**/*.go", "**/*.rb", "**/*.php", "**/*.rs", "**/*.c", "**/*.cc", "**/*.cpp", "**/*.cxx", "**/*.h", "**/*.hh", "**/*.hpp", "**/*.hxx", "**/*.sh", "**/*.ps1", "**/*.sql"]
references: CWE Top 25 (CWE-78, CWE-79, CWE-89, CWE-94, CWE-22, CWE-502, CWE-918, CWE-77, CWE-434, CWE-611); OWASP ASVS 5.0 encoding and sanitization
---
Trace data from where it enters (request parameters, headers, files, environment, CLI arguments, messages, database rows written by users) to where it is used. Report only a path you can cite end to end.

Check these sinks:
- OS commands: shell=True, os.system, subprocess with a string, exec/spawn with a shell, backticks (CWE-78, CWE-77).
- Code evaluation: eval, exec, Function(), dynamic import or require of a variable, template engines rendering user templates (CWE-94).
- SQL and query languages built by string concatenation or formatting instead of parameters (CWE-89); the same for LDAP, XPath, NoSQL filters.
- HTML output without context-aware encoding: innerHTML, dangerouslySetInnerHTML, |safe, raw templates, document.write (CWE-79).
- File paths joined from input without normalizing and checking they stay under a base directory; archive extraction (zip slip) (CWE-22).
- Deserialization of untrusted data: pickle, yaml.load without a safe loader, Java/.NET native serialization, Marshal (CWE-502).
- Outbound requests to a URL or host taken from input (SSRF), including redirects and metadata addresses (CWE-918).
- XML parsers with external entities enabled (CWE-611); uploads stored with their original name or type (CWE-434).

A sink is safe when the value is a constant, comes from an allow-list, is passed as a parameter or argument array, or is validated against the exact form the sink needs. Say which guard you checked when you reject a candidate.
