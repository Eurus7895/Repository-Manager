---
id: python-security
name: Python
category: security
appliesTo: ["**/*.py"]
references: Amazon Q / CodeGuru detector library, Python security category; Bandit test families; CWE-78, CWE-502, CWE-377, CWE-295, CWE-703
---
Python specifics to check, in addition to the general sinks:
- subprocess with shell=True or a single command string built from input; os.system, os.popen, commands.
- pickle, marshal, shelve or yaml.load (without SafeLoader) on data that crosses a trust boundary; jsonpickle.
- tempfile.mktemp or predictable temporary paths (CWE-377); world-writable files from os.chmod.
- requests or urllib with verify=False, or ssl contexts that disable checks; HTTP clients without timeouts.
- assert used for access control or input validation (asserts are removed with -O).
- Flask or Django debug mode on in production settings; DEBUG=True, SECRET_KEY in source, ALLOWED_HOSTS = ['*'].
- SQL built with f-strings, % or .format passed to cursor.execute; Django raw() or extra() with formatting.
- XML parsing with xml.etree, minidom or lxml on untrusted input without defusedxml.
- Bare except: or except Exception: pass around security-relevant code that hides failures (CWE-703).
- logging of request bodies, headers or tokens.
