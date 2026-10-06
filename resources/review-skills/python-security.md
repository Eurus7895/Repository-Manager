---
id: python-security
name: Python
category: security
appliesTo: ["**/*.py"]
references: Amazon Q / CodeGuru detector library, Python security category; Bandit test families; CWE-78, CWE-89, CWE-502, CWE-611, CWE-377, CWE-617, CWE-703
---
Python APIs for the general sinks, and Python-only pitfalls:
- Commands: subprocess with shell=True or a single string built from input; os.system, os.popen (CWE-78).
- SQL: f-strings, % or .format passed to cursor.execute; Django raw() or extra() with formatted strings (CWE-89).
- Deserialization: pickle, marshal, shelve, jsonpickle, or yaml.load / yaml.unsafe_load with a loader other than SafeLoader, on data that crosses a trust boundary (CWE-502).
- XML: lxml with resolve_entities=True or no_network=False, or xml.sax with external general entities turned on, on untrusted input (CWE-611). The standard xml.etree parsers do not fetch external entities; report them only for entity-expansion attacks where the Python or expat version is known to be old.
- tempfile.mktemp or predictable temporary paths (CWE-377); files made world-writable with os.chmod.
- assert used for access control or input validation: asserts are removed with -O (CWE-617).
- Flask or Django debug mode in production settings: DEBUG=True, app.run(debug=True), ALLOWED_HOSTS = ['*'].
- Bare except: or except Exception: pass around security checks, so a failure lets the request through (CWE-703).

Cite the call and the input that reaches it.
